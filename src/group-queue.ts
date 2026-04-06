import { ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.debug({ groupJid }, 'Container active, message queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_CONTAINERS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.debug(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;

    // When process exits externally (Docker stop, kill, crash), release active
    // state and drain pending work. Without this, host-mode early-resolve leaves
    // state.active=true after the process dies, swallowing pending messages.
    proc.on('exit', () => {
      if (state.active && state.idleWaiting) {
        logger.info(
          { groupJid },
          'Process exited while idle-waiting, releasing active state',
        );
        // Clean up stale IPC files that were written for this now-dead process
        if (state.groupFolder) {
          const inputDir = path.join(
            DATA_DIR,
            'ipc',
            state.groupFolder,
            'input',
          );
          try {
            const files = fs
              .readdirSync(inputDir)
              .filter((f) => f.endsWith('.json'));
            for (const f of files) {
              fs.unlinkSync(path.join(inputDir, f));
            }
            if (files.length > 0) {
              logger.info(
                { groupJid, count: files.length },
                'Cleaned stale IPC files',
              );
              // Re-set pendingMessages so drainGroup picks them up from DB
              state.pendingMessages = true;
            }
          } catch {
            /* ignore */
          }
        }
        state.active = false;
        state.idleWaiting = false;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
        this.activeCount--;
        this.drainGroup(groupJid);
      }
    });
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  markIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
  }

  sendMessage(groupJid: string, text: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) {
      logger.info(
        {
          groupJid,
          active: state.active,
          hasFolder: !!state.groupFolder,
          isTask: state.isTaskContainer,
        },
        'sendMessage: rejected (no active container or wrong state)',
      );
      return false;
    }
    // Check process is actually alive — prevents piping to dead process's IPC dir
    if (state.process && state.process.exitCode !== null) {
      logger.info(
        { groupJid, exitCode: state.process.exitCode },
        'sendMessage: rejected (process already exited)',
      );
      return false;
    }
    state.idleWaiting = false;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
      fs.renameSync(tempPath, filepath);
      logger.info({ groupJid, file: filename }, 'sendMessage: piped to IPC');
      return true;
    } catch (err) {
      logger.info({ groupJid, err }, 'sendMessage: IPC write failed');
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      // Check if the process is truly alive — Docker stop doesn't set process.killed,
      // but exitCode becomes non-null when the process exits.
      const processAlive =
        state.process &&
        state.process.exitCode === null &&
        !state.process.killed;
      if (processAlive && state.idleWaiting) {
        logger.debug({ groupJid }, 'Agent idle-waiting for IPC');
      } else {
        state.active = false;
        state.process = null;
        state.containerName = null;
        state.groupFolder = null;
        this.activeCount--;
      }
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      // If process is idle-waiting, close it and re-enqueue
      // so a fresh processGroupMessages picks up new messages
      if (
        state.active &&
        state.idleWaiting &&
        state.process &&
        !state.process.killed
      ) {
        // Process is alive and idle — pipe new messages via IPC instead of killing.
        // processMessagesFn will read from DB and call sendMessage() which writes
        // IPC files that the idle agent reads.
        state.pendingMessages = false;
        if (this.processMessagesFn) {
          this.processMessagesFn(groupJid).catch((err) =>
            logger.error(
              { groupJid, err },
              'Error piping messages to idle agent',
            ),
          );
        }
        return;
      }
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_CONTAINERS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    // Kill all active agent processes on shutdown.
    // Host-mode agents are spawned with detached:true, so they survive parent exit
    // unless explicitly killed. Without this, restart leaves orphaned agents.
    const killed: string[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed) {
        const name = state.containerName || jid;
        try {
          this.killProcess(state.process, 'SIGTERM');
          killed.push(name);
        } catch {
          // Process already dead
        }
      }
    }

    if (killed.length > 0) {
      // Give agents a moment to clean up, then force kill
      await new Promise((r) => setTimeout(r, Math.min(gracePeriodMs, 3000)));
      for (const [, state] of this.groups) {
        if (state.process && !state.process.killed) {
          try {
            this.killProcess(state.process, 'SIGKILL');
          } catch {
            /* already dead */
          }
        }
      }
    }

    logger.info(
      { activeCount: this.activeCount, killed },
      'GroupQueue shutting down (agents terminated)',
    );
  }

  /** Cross-platform process kill. Windows uses taskkill /T for tree kill. */
  private killProcess(
    proc: ChildProcess,
    signal: NodeJS.Signals = 'SIGTERM',
  ): void {
    if (!proc.pid) {
      proc.kill(signal);
      return;
    }
    if (process.platform === 'win32') {
      // Windows: taskkill /T kills the process tree (equivalent to -pid on Unix)
      const flag = signal === 'SIGKILL' ? '/F' : '';
      try {
        execSync(`taskkill ${flag} /T /PID ${proc.pid}`, { stdio: 'pipe' });
      } catch {
        proc.kill(signal);
      }
    } else {
      // Unix: kill the process group
      try {
        process.kill(-proc.pid, signal);
      } catch {
        proc.kill(signal);
      }
    }
  }
}
