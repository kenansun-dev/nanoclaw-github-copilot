/**
 * Per-group daily memory summarizer cron registration.
 *
 * Idempotently ensures that every active group has a scheduled task
 * which, at the configured local time, asks the agent to summarize the
 * day's chat history and append the highlights to today's daily memory
 * journal via the `memory_append_today` MCP tool.
 *
 * Wires into the existing nanoclaw task scheduler (cron-parser + TZ),
 * so we don't need a second cron mechanism.
 *
 * Defaults (overridable via nanoclaw.json):
 *   memory.dailySummary.enabled  = true
 *   memory.dailySummary.cron     = "45 23 * * *"  (23:45 local time)
 *   memory.dailySummary.prompt   = (built-in prompt below)
 *
 * Why 23:45 (kenan, 2026-04-19)? See features/memory.md → "为什么默认
 * 23:45". Short version: late enough to capture the full day's chatter,
 * still in the same local day (so today's journal carries today's
 * entries), with ~15 min buffer for the summarization turn to finish
 * before midnight.
 *
 * The task is keyed by `id = "memory-daily-summary:<chatJid>"` so we
 * can safely detect & skip if it already exists, and recreate if the
 * cron expression or prompt changed.
 */
import { CronExpressionParser } from 'cron-parser';

import { TIMEZONE } from './../config.js';
import { loadConfig } from './../config-loader.js';
import { createTask, getTaskById, updateTask } from './../db.js';
import { logger } from './../log-extensions.js';
// Need 'status' in the partial type now that we pause on disable.
import type { ScheduledTask } from './../types-extensions.js';

const DEFAULT_CRON = '45 23 * * *';
const DEFAULT_ENABLED = true;
const DEFAULT_PROMPT = [
  'Summarize today\u2019s chat history for this group and append the',
  'highlights to today\u2019s memory journal using the `memory_append_today`',
  'MCP tool. Aim for 3\u20137 short bullets.',
  '',
  'What to capture:',
  '- decisions made (with brief rationale)',
  '- non-trivial actions taken (PRs opened, deploys, long tasks)',
  '- lessons learned or things to avoid repeating',
  '- user preferences expressed during the day',
  '',
  'What to skip:',
  '- greetings, acks, small talk',
  '- entire command outputs (summarize instead)',
  '- secrets, tokens, API keys, PII',
  '',
  'Make one `memory_append_today` call per highlight (so each gets its',
  'own timestamp). If nothing noteworthy happened, append a single bullet',
  '"\u2014 quiet day".',
].join('\n');

interface DailySummaryConfig {
  enabled: boolean;
  cron: string;
  prompt: string;
}

function resolveDailySummaryConfig(): DailySummaryConfig {
  const cfg = loadConfig() as unknown as Record<string, unknown>;
  const memory = (cfg.memory as Record<string, unknown> | undefined) ?? {};
  const ds = (memory.dailySummary as Record<string, unknown> | undefined) ?? {};
  return {
    enabled: typeof ds.enabled === 'boolean' ? ds.enabled : DEFAULT_ENABLED,
    cron: typeof ds.cron === 'string' && ds.cron.trim() ? ds.cron : DEFAULT_CRON,
    prompt: typeof ds.prompt === 'string' && ds.prompt.trim() ? ds.prompt : DEFAULT_PROMPT,
  };
}

function taskIdFor(chatJid: string): string {
  return `memory-daily-summary:${chatJid}`;
}

function nextRunFromCron(cron: string): string | null {
  try {
    const it = CronExpressionParser.parse(cron, { tz: TIMEZONE });
    return it.next().toISOString();
  } catch (err) {
    logger.warn({ cron, err }, 'memory-daily-summary: invalid cron expression');
    return null;
  }
}

/**
 * Ensure a daily-summary scheduled task is in sync with config.
 * Safe to call on every agent spawn (idempotent + caches first-time log).
 *
 * Source-of-truth model: config wins.
 * - enabled=true,  no task        → create active
 * - enabled=true,  task active    → sync cron/prompt drift in place
 * - enabled=true,  task paused    → leave status alone (user paused manually)
 *                                  but still sync cron/prompt drift
 * - enabled=false, task active    → pause (don't delete; preserves history)
 * - enabled=false, task paused    → no-op
 * - enabled=false, no task        → no-op
 *
 * The pause-on-disable behaviour means flipping `enabled: false` in
 * config takes effect on the next agent spawn (or process restart).
 * Users can still resume manually with `nanoclaw task resume <id>` and
 * we won't re-pause until the next config-disabled spawn after a
 * user-initiated re-enable cycle. Pure resume is intentional: it lets
 * an operator override the config switch without editing yaml.
 */
// One-shot log dedup per process: don't spam every spawn.
const loggedFirstRegistration = new Set<string>();

export function ensureDailySummaryTask(opts: { chatJid: string; groupFolder: string }): void {
  const { chatJid, groupFolder } = opts;
  const config = resolveDailySummaryConfig();
  const id = taskIdFor(chatJid);
  const existing = getTaskById(id) as ScheduledTask | undefined;

  // Disabled path: pause active task, otherwise no-op. Never delete
  // (preserves last_run/last_result for diagnostics).
  if (!config.enabled) {
    if (existing && existing.status === 'active') {
      try {
        updateTask(id, { status: 'paused' });
        logger.info({ id, chatJid }, 'memory-daily-summary: paused (memory.dailySummary.enabled=false)');
      } catch (err) {
        logger.warn({ id, err }, 'memory-daily-summary: pause-on-disable failed (non-fatal)');
      }
    }
    return;
  }

  // Enabled path: create if missing, sync drift if present.
  if (!existing) {
    const next = nextRunFromCron(config.cron);
    if (!next) return;
    try {
      createTask({
        id,
        group_folder: groupFolder,
        chat_jid: chatJid,
        prompt: config.prompt,
        script: null,
        schedule_type: 'cron',
        schedule_value: config.cron,
        // detached by default: daily-summary task should not occupy the
        // chat slot. With slot-key indirection in GroupQueue (proposal
        // §4.1.A), 'isolated' tasks run in a separate slot and the chat
        // remains live for user messages while the summary runs.
        context_mode: 'isolated',
        next_run: next,
        status: 'active',
        created_at: new Date().toISOString(),
      });
      // First-time-per-process log so users can discover the feature
      // without grepping schema migrations. Subsequent spawns for the
      // same chat are silent.
      if (!loggedFirstRegistration.has(id)) {
        loggedFirstRegistration.add(id);
        logger.info(
          { id, chatJid, cron: config.cron, next, tz: TIMEZONE },
          `memory-daily-summary: registered for ${chatJid} at ${config.cron} (${TIMEZONE}). Disable with memory.dailySummary.enabled=false.`,
        );
      }
    } catch (err) {
      logger.warn({ id, err }, 'memory-daily-summary: createTask failed (non-fatal)');
    }
    return;
  }

  // Drift check: if cron or prompt changed, update in place. Don't
  // disturb status (user may have paused it manually) or last_run.
  const driftedCron = existing.schedule_value !== config.cron;
  const driftedPrompt = existing.prompt !== config.prompt;
  if (driftedCron || driftedPrompt) {
    const patch: Partial<ScheduledTask> = {};
    if (driftedCron) {
      patch.schedule_value = config.cron;
      const next = nextRunFromCron(config.cron);
      if (next) patch.next_run = next;
    }
    if (driftedPrompt) patch.prompt = config.prompt;
    try {
      updateTask(id, patch);
      logger.info({ id, driftedCron, driftedPrompt }, 'memory-daily-summary: updated cron task to match config');
    } catch (err) {
      logger.warn({ id, err }, 'memory-daily-summary: updateTask failed (non-fatal)');
    }
  }

  // Auto-resume: if the scheduler paused this task because its group
  // was missing for several consecutive ticks (see
  // task-scheduler.MAX_CONSECUTIVE_GROUP_MISSING), and we are now being
  // called again from host-runner — meaning the group has come back
  // online and is about to run an agent — flip the task back to active
  // and schedule the next cron tick. We use the
  // `consecutive_group_missing` counter rather than parsing
  // last_result, so a manual user-pause (counter == 0) is preserved.
  const wasAutoPaused = existing.status === 'paused' && (existing.consecutive_group_missing ?? 0) > 0;
  if (wasAutoPaused) {
    const next = nextRunFromCron(config.cron);
    try {
      updateTask(id, {
        status: 'active',
        consecutive_group_missing: 0,
        ...(next ? { next_run: next } : {}),
      });
      logger.info({ id, chatJid, groupFolder, next }, 'memory-daily-summary: resumed task after group came back');
    } catch (err) {
      logger.warn({ id, err }, 'memory-daily-summary: auto-resume failed (non-fatal)');
    }
  }
}
