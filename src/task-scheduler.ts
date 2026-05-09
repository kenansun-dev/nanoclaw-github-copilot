import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import { runAgentForChat, resolveAgentForChat, getAgentProvider } from './config-extensions.js';
import { ContainerOutput, runContainerAgent, writeTasksSnapshot } from './container-runner.js';
import {
  clearConsecutiveGroupMissing,
  getAllTasks,
  getDueTasks,
  getTaskById,
  incrementConsecutiveGroupMissing,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './log-extensions.js';
import { RegisteredGroup, ScheduledTask } from './types-extensions.js';

/**
 * Number of consecutive scheduler ticks a task may fail to find its
 * `group_folder` in `registeredGroups` before the scheduler auto-pauses
 * it. Pausing stops the once-per-poll-interval log spam for orphan tasks
 * whose group has been unregistered (e.g. TUI session ended, channel
 * logged out, group migration left the row behind). Tasks resume
 * automatically when their owner re-registers via `ensureDailySummaryTask`
 * or any equivalent re-bind path.
 */
export const MAX_CONSECUTIVE_GROUP_MISSING = 3;

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn({ taskId: task.id, value: task.schedule_value }, 'Invalid interval value');
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, Record<string, string>>;
  queue: GroupQueue;
  onProcess: (groupJid: string, proc: ChildProcess, containerName: string, groupFolder: string) => void;
  sendMessage: (jid: string, text: string) => Promise<string | void>;
  editMessage?: (jid: string, messageId: string, text: string) => Promise<string | void>;
}

async function runTask(task: ScheduledTask, deps: SchedulerDependencies): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error({ taskId: task.id, groupFolder: task.group_folder, error }, 'Task has invalid group folder');
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info({ taskId: task.id, group: task.group_folder }, 'Running scheduled task');

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find((g) => g.folder === task.group_folder);

  if (!group) {
    const missCount = incrementConsecutiveGroupMissing(task.id);
    const shouldPause = missCount >= MAX_CONSECUTIVE_GROUP_MISSING;
    const errorMsg = `Group not found: ${task.group_folder}`;

    if (shouldPause) {
      // Auto-pause stops the once-per-poll log spam (was 1440 lines/day
      // for a daily-summary task on a 60s scheduler tick) when the group
      // is gone for good. `ensureDailySummaryTask` (and any other
      // re-binder) will flip status back to 'active' and reset the
      // counter when the group reappears.
      updateTask(task.id, { status: 'paused' });
      logger.error(
        {
          taskId: task.id,
          groupFolder: task.group_folder,
          missCount,
          threshold: MAX_CONSECUTIVE_GROUP_MISSING,
        },
        'Pausing task: group missing for consecutive ticks',
      );
    } else {
      logger.error(
        {
          taskId: task.id,
          groupFolder: task.group_folder,
          missCount,
          threshold: MAX_CONSECUTIVE_GROUP_MISSING,
        },
        'Group not found for task',
      );
    }

    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: errorMsg,
    });

    // Always advance `next_run` even on this failure path. Without this,
    // the task stays "due" on every scheduler poll and the loop fires
    // again ~SCHEDULER_POLL_INTERVAL later, creating a tight retry loop
    // independent of the task's real schedule. updateTaskAfterRun also
    // moves a once-task to status='completed' when computeNextRun
    // returns null, which is the correct terminal state.
    const nextRun = computeNextRun(task);
    const summary = shouldPause
      ? `Paused after ${missCount} missing-group ticks`
      : `Group missing (${missCount}/${MAX_CONSECUTIVE_GROUP_MISSING})`;
    updateTaskAfterRun(task.id, nextRun, summary);
    return;
  }

  // Group is back (or has always been here): clear any prior
  // missing-group streak so a transient gap doesn't eventually pause an
  // otherwise-healthy task.
  if (task.consecutive_group_missing !== undefined && task.consecutive_group_missing > 0) {
    clearConsecutiveGroupMissing(task.id);
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session for THIS provider
  const sessions = deps.getSessions();
  const taskAgent = resolveAgentForChat(task.chat_jid);
  const taskProvider = getAgentProvider(taskAgent);
  const sessionId = task.context_mode === 'group' ? sessions[task.group_folder]?.[taskProvider] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  try {
    const agent = taskAgent;
    // Progressive send state for delta streaming
    let progressiveMsgId: string | undefined;
    const output = await runAgentForChat(
      task.chat_jid,
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: agent.name || ASSISTANT_NAME,
        script: task.script || undefined,
      },
      (proc, containerName) => deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        if (streamedOutput.result) {
          const text = streamedOutput.result;
          result = text;
          // Skip empty / whitespace-only results: the scheduled-task
          // prompt tells the agent to reply with an empty string when it
          // has nothing useful to report. Don't push noise to the channel.
          if (!text.trim()) {
            // skip forward, but still record result for run log
          } else if (streamedOutput.partial && deps.editMessage) {
            if (!progressiveMsgId) {
              const msgId = await deps.sendMessage(task.chat_jid, text + ' ◌');
              progressiveMsgId = typeof msgId === 'string' ? msgId : undefined;
            } else {
              await deps.editMessage(task.chat_jid, progressiveMsgId, text + ' ◌');
            }
          } else {
            if (progressiveMsgId && deps.editMessage) {
              await deps.editMessage(task.chat_jid, progressiveMsgId, text);
              progressiveMsgId = undefined;
            } else {
              await deps.sendMessage(task.chat_jid, text);
            }
            scheduleClose();
          }
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose();
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
        }
      },
    );

    if (closeTimer) clearTimeout(closeTimer);

    if (output.status === 'error') {
      error = output.error || 'Unknown error';
    } else if (output.result) {
      // Result was already forwarded to the user via the streaming callback above
      result = output.result;
    }

    logger.info({ taskId: task.id, durationMs: Date.now() - startTime }, 'Task completed');
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error ? `Error: ${error}` : result ? result.slice(0, 200) : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () => runTask(currentTask, deps));
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
