import { ChildProcess, execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_CONTAINERS } from './config.js';
import { logger } from './log.js';

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
  /**
   * Number of user messages piped into the active agent since it last produced
   * output. Used to decide whether to send a "busy ack" so the user knows
   * their follow-up landed while the agent is still chewing on the prior turn.
   * Reset to 0 on agent output / new spawn / kill.
   */
  pipedSinceOutput: number;
  /** True once the active agent has produced any reply for the current turn. */
  agentHasOutput: boolean;
  /**
   * Earliest user-message timestamp piped into the active agent for the
   * current in-flight query that has NOT yet been ack'd by an agent reply.
   * `null` = nothing in flight. Used by the process-died handler to roll
   * the cursor back so dropped messages get re-processed by the next
   * agent spawn (cursor was advanced when the IPC pipe succeeded —
   * without rollback the message is silently lost on agent crash/timeout).
   */
  inFlightCursorRollback: string | null;
  /**
   * Monotonic counter incremented on EVERY user message that becomes a new
   * turn for the agent: both the initial turn (when the queue spawns a
   * container or runs the first prompt) and every follow-up message piped
   * to an already-running container's stdin via IPC. The dispatcher in
   * src/index.ts uses this to detect a turn boundary even when the SDK
   * does not fire its newSessionId sentinel — that sentinel only fires
   * for the FIRST turn of a session, and follow-up piped messages reuse
   * the same sessionId, leaving the dispatcher's pendingResult flag
   * unset and causing it to edit the previous turn's reply (kenan TG
   * repro 2026-04-25 22:34 / 22:54).
   */
  userTurnSeq: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;
  /**
   * Optional listener invoked when the active process dies before producing
   * any output for piped IPC messages. Receives the rollback cursor (the
   * earliest piped-but-unacked message timestamp). Caller (index.ts) uses
   * this to restore lastAgentTimestamp so the messages are re-processed by
   * the next agent spawn, and to clear the typing indicator that was set
   * fire-and-forget at the IPC pipe site.
   */
  private onProcessDiedWithoutOutput:
    | ((
        groupJid: string,
        rollbackTimestamp: string | null,
        exitCode: number | null,
      ) => void)
    | null = null;

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
        pipedSinceOutput: 0,
        agentHasOutput: false,
        inFlightCursorRollback: null,
        userTurnSeq: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  /**
   * Register a listener that fires when the active host process dies
   * before producing output for piped IPC messages. The listener is called
   * with `(groupJid, rollbackTimestamp)` where rollbackTimestamp is the
   * earliest piped-but-unacked message timestamp (or null if nothing was
   * in flight). See `inFlightCursorRollback` on `GroupState` for context.
   */
  setOnProcessDiedWithoutOutput(
    fn: (
      groupJid: string,
      rollbackTimestamp: string | null,
      exitCode: number | null,
    ) => void,
  ): void {
    this.onProcessDiedWithoutOutput = fn;
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
      // Two cases we handle here (and ONLY these two):
      //   (1) state.active && state.idleWaiting  — IPC-mode agent was
      //       sitting idle waiting for the next pipe, then died.
      //   (2) state.active && pipedSinceOutput > 0 && !agentHasOutput —
      //       IPC-mode agent had a pipe in flight (idleWaiting cleared by
      //       sendMessage), then died before producing output.
      // We must NOT fire during the initial query phase (state.active=true,
      // idleWaiting=false, pipedSinceOutput=0). In that path runContainer's
      // finally block owns the cleanup; double-cleanup here would corrupt
      // activeCount.
      const isCase1 = state.active && state.idleWaiting;
      const isCase2 =
        state.active && state.pipedSinceOutput > 0 && !state.agentHasOutput;
      // Case 3 (added 2026-04-21 after kenan's silent-crash report): IPC-mode
      // agent had already delivered output for this turn (agentHasOutput=true,
      // idleWaiting=false because sendMessage cleared it on the most recent
      // pipe), then died with non-zero code. Without this branch, runContainer's
      // finally has long since returned (resolved at first query-complete), so
      // state.active stays true and state.process keeps a dangling reference
      // to the dead child. Next sendMessage then rejects with 'process already
      // exited' — user sees radio silence forever. Symptom: kenan 08:04 sent
      // gitignore request; agent exited code=1; bot replied nothing; later '?'
      // also rejected. Fix: treat any active-and-not-cleaned-up exit as needing
      // cleanup so the next message can respawn.
      const isCase3 =
        state.active && !state.idleWaiting && state.agentHasOutput;
      if (isCase1 || isCase2 || isCase3) {
        const hadInFlight = state.pipedSinceOutput > 0 && !state.agentHasOutput;
        const rollbackCursor = state.inFlightCursorRollback;
        const exitCode = (proc as any).exitCode;
        const caseLabel = isCase2
          ? 'piped-then-died'
          : isCase3
            ? 'delivered-then-died'
            : 'idle-then-died';
        logger.info(
          {
            groupJid,
            case: caseLabel,
            inFlightCursorRollback: rollbackCursor,
            pipedSinceOutput: state.pipedSinceOutput,
            agentHasOutput: state.agentHasOutput,
            hadInFlight,
            exitCode,
          },
          'Active process exited, releasing state',
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
        state.inFlightCursorRollback = null;
        this.activeCount--;
        // Notify subscriber (index.ts) so it can rollback the cursor (if
        // there were piped-but-unacked messages), clear the typing
        // indicator, and surface a non-zero exit to the user. We now fire
        // unconditionally on case3 (delivered-then-died) too, because a
        // non-zero exit there still means the next user message would
        // otherwise see silence; index.ts decides whether to message based
        // on exitCode.
        if (this.onProcessDiedWithoutOutput && (hadInFlight || isCase3)) {
          try {
            this.onProcessDiedWithoutOutput(
              groupJid,
              hadInFlight ? rollbackCursor : null,
              exitCode,
            );
          } catch (err) {
            logger.warn(
              { groupJid, err },
              'onProcessDiedWithoutOutput listener threw',
            );
          }
        }
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

  sendMessage(
    groupJid: string,
    text: string,
    rollbackCursor?: string,
  ): boolean {
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
    // Check process is actually alive — prevents piping to dead process's IPC dir.
    // If the process has exited but state hasn't been cleaned up yet (race with
    // proc.on('exit')), tear down the dangling state and queue this message as
    // pending so drainGroup can respawn. Without this, a crashed agent leaves
    // the user wedged: every subsequent message gets rejected and they see
    // radio silence until 'nanoclaw restart'. (kenan, 2026-04-21)
    if (state.process && state.process.exitCode !== null) {
      logger.info(
        { groupJid, exitCode: state.process.exitCode },
        'sendMessage: process already exited — cleaning up and re-queuing',
      );
      const wasActive = state.active;
      state.active = false;
      state.idleWaiting = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      state.inFlightCursorRollback = null;
      if (wasActive) this.activeCount--;
      // Caller will persist this message to DB; we just signal pending and
      // let drainGroup pick it up on the next tick.
      state.pendingMessages = true;
      this.drainGroup(groupJid);
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
      state.pipedSinceOutput += 1;
      state.userTurnSeq += 1;
      // Track the *earliest* unacked piped-message cursor for rollback on
      // process death. Don't overwrite if already set — we want the oldest
      // in-flight cursor so subsequent pipes don't lose history.
      if (rollbackCursor && !state.inFlightCursorRollback) {
        state.inFlightCursorRollback = rollbackCursor;
      }
      logger.info(
        {
          groupJid,
          file: filename,
          pipedSinceOutput: state.pipedSinceOutput,
          inFlightCursorRollback: state.inFlightCursorRollback,
        },
        'sendMessage: piped to IPC',
      );
      return true;
    } catch (err) {
      logger.info({ groupJid, err }, 'sendMessage: IPC write failed');
      return false;
    }
  }

  /**
   * Returns the current user-turn sequence number for a group. Dispatcher
   * uses this to detect a new turn even when the SDK does not fire a
   * newSessionId sentinel (follow-up messages piped to a running container).
   */
  getUserTurnSeq(groupJid: string): number {
    return this.getGroup(groupJid).userTurnSeq;
  }

  /**
   * Notify the queue that the active agent produced output for the user.
   * Resets the busy-ack debounce so subsequent piped messages can be
   * acked again if the agent goes silent for another long stretch.
   */
  notifyAgentOutput(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.pipedSinceOutput = 0;
    state.agentHasOutput = true;
    // Output landed — piped IPC messages have been acked, no rollback needed
    // if the agent dies after this point.
    state.inFlightCursorRollback = null;
  }

  /**
   * Should we send a "busy ack" to the user right now?
   *
   * Rule: ack only on the **2nd** piped message while the agent has not yet
   * produced any output for this turn. The 1st message is covered by the
   * typing indicator; 3rd+ messages are silent (the user already knows we
   * received #2 and are working through them).
   *
   * Returns the queue depth (currently always literally `2` when triggered)
   * to surface in the ack message — callers in `index.ts` interpolate it as
   * "这是第 N 条". Return type kept as `number | null` (not `2 | null`) so the
   * threshold can be raised without a type-signature change. Returns null if
   * no ack needed.
   *
   * TODO(i18n): the ack text is hardcoded zh-CN in `index.ts`. Move both the
   * ack and the abort-trigger normalization to a per-channel locale layer
   * when we onboard non-zh groups.
   */
  shouldSendBusyAck(groupJid: string): number | null {
    const state = this.getGroup(groupJid);
    if (state.agentHasOutput) return null;
    if (state.pipedSinceOutput === 2) return state.pipedSinceOutput;
    return null;
  }

  /**
   * Fast-abort: forcibly kill the active process for this group, clear any
   * pending IPC messages, and drop pending tasks. Used by the abort-triggers
   * path when a user sends 'stop' / 'cancel' / etc. while the agent is busy.
   *
   * Returns true if something was actually killed (active state was set).
   */
  killActive(groupJid: string): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active) return false;

    // 1) Clear pending IPC input files so a respawn won't replay them
    if (state.groupFolder) {
      const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
      try {
        if (fs.existsSync(inputDir)) {
          const files = fs
            .readdirSync(inputDir)
            .filter((f) => f.endsWith('.json') || f === '_close');
          for (const f of files) {
            try {
              fs.unlinkSync(path.join(inputDir, f));
            } catch {
              /* ignore */
            }
          }
          if (files.length > 0) {
            logger.info(
              { groupJid, count: files.length },
              'abort: cleared IPC backlog',
            );
          }
        }
      } catch (err) {
        logger.warn({ groupJid, err }, 'abort: failed to clear IPC backlog');
      }
    }

    // 2) Drop pending tasks (interactive prompts still in the queue)
    state.pendingTasks = [];
    state.pendingMessages = false;

    // 3) Kill the process. The 'exit' handler registered in registerProcess()
    //    will flip state.active=false and decrement activeCount.
    const proc = state.process;
    if (proc && !proc.killed) {
      try {
        proc.kill('SIGTERM');
        logger.info(
          { groupJid, pid: proc.pid },
          'abort: SIGTERM sent to agent',
        );
      } catch (err) {
        logger.warn({ groupJid, err }, 'abort: SIGTERM failed');
      }
      // Escalate if it doesn't die in 2s
      setTimeout(() => {
        if (proc && !proc.killed) {
          try {
            proc.kill('SIGKILL');
            logger.warn(
              { groupJid, pid: proc.pid },
              'abort: SIGKILL escalation',
            );
          } catch {
            /* ignore */
          }
        }
      }, 2000).unref?.();
    } else if (state.containerName) {
      // Process handle lost but container name still set — try docker stop
      try {
        execSync(`docker kill ${state.containerName}`, { stdio: 'ignore' });
        logger.info(
          { groupJid, container: state.containerName },
          'abort: docker kill sent',
        );
      } catch {
        /* ignore */
      }
    }

    return true;
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
    state.pipedSinceOutput = 0;
    state.agentHasOutput = false;
    state.inFlightCursorRollback = null;
    state.userTurnSeq += 1;
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
