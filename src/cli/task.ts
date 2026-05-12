/**
 * `nanoclaw task` CLI — list / inspect scheduled tasks from outside chat.
 *
 * Why this exists (kenan + VM 2026-04-27):
 *   The `scheduled_tasks` row store is global, but until now the only way
 *   to look at it was the in-chat `/tasks` slash command (agent-mediated,
 *   filtered to the current chat's group). For deploy / debug we need a
 *   host-level "show me everything that's scheduled" view that doesn't
 *   need a chat context.
 *
 * Design:
 *   `nanoclaw task list`            — every task across every chat
 *   `nanoclaw task list --chat JID` — filter to one chat_jid
 *   `nanoclaw task list --status S` — filter by status (active|paused|completed)
 *   `nanoclaw task info <id>`       — full row + recent run logs
 *
 * Default = `--all` (no flag = global view) is the explicit decision in
 * channel discussion: CLI invokers are admins, an empty default to "main
 * chat" would be ambiguous and misleading.
 *
 * Slash `/tasks` in chat is unchanged — still agent-mediated and still
 * filters to the calling chat (that's the right default for end users).
 */

import {
  getAllTasks,
  getTaskById,
  getTaskRunLogs,
  initDatabase,
  createTask,
  getRegisteredGroup,
  getAllRegisteredGroups,
} from '../db.js';
import { ScheduledTask } from '../types-extensions.js';
import { CronExpressionParser } from 'cron-parser';
import { formatTasksText, modeLabel } from './task-format.js';

interface TaskRunLog {
  id: number;
  task_id: string;
  run_at: string;
  duration_ms: number;
  status: string;
  result: string | null;
  error: string | null;
}

// (db handle stays private to db.ts; this CLI uses its public helpers.)

function fmtRel(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return iso;
  const diff = t - Date.now();
  const abs = Math.abs(diff);
  const min = Math.round(abs / 60000);
  const hr = Math.round(abs / 3600000);
  const day = Math.round(abs / 86400000);
  let rel: string;
  if (abs < 60000) rel = '<1m';
  else if (min < 60) rel = `${min}m`;
  else if (hr < 48) rel = `${hr}h`;
  else rel = `${day}d`;
  return diff >= 0 ? `in ${rel}` : `${rel} ago`;
}

function fmtSchedule(t: ScheduledTask): string {
  switch (t.schedule_type) {
    case 'cron':
      return `cron ${t.schedule_value}`;
    case 'interval': {
      const ms = parseInt(t.schedule_value, 10);
      if (!Number.isFinite(ms)) return `interval ${t.schedule_value}`;
      const sec = Math.round(ms / 1000);
      if (sec < 60) return `every ${sec}s`;
      if (sec < 3600) return `every ${Math.round(sec / 60)}m`;
      return `every ${Math.round(sec / 3600)}h`;
    }
    case 'once':
      return `once @ ${t.schedule_value}`;
    default:
      return `${t.schedule_type} ${t.schedule_value}`;
  }
}

function previewPrompt(s: string, max = 60): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max - 1) + '…';
}

async function listTasks(opts: { chat?: string; status?: string; json?: boolean }): Promise<void> {
  let rows = getAllTasks();
  if (opts.chat) rows = rows.filter((t) => t.chat_jid === opts.chat);
  if (opts.status) rows = rows.filter((t) => t.status === opts.status);
  // Re-sort: status, then next_run ascending (nulls last)
  rows = rows.slice().sort((a, b) => {
    if (a.status !== b.status) return a.status < b.status ? -1 : 1;
    const an = a.next_run ? new Date(a.next_run).getTime() : Infinity;
    const bn = b.next_run ? new Date(b.next_run).getTime() : Infinity;
    return an - bn;
  });

  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  const filterBits: string[] = [];
  if (opts.chat) filterBits.push(`chat=${opts.chat}`);
  if (opts.status) filterBits.push(`status=${opts.status}`);
  console.log(
    formatTasksText(rows, {
      compact: false,
      filterDesc: filterBits.join(', ') || undefined,
    }),
  );
}

async function infoTask(id: string, opts: { json?: boolean }): Promise<void> {
  const task = getTaskById(id);
  if (!task) {
    console.error(`No task with id: ${id}`);
    process.exitCode = 1;
    return;
  }
  const logs = getTaskRunLogs(id, 10) as TaskRunLog[];

  if (opts.json) {
    console.log(JSON.stringify({ task, recentRuns: logs }, null, 2));
    return;
  }

  console.log(`Task ${task.id}`);
  console.log(`  status:        ${task.status}`);
  console.log(`  schedule:      ${fmtSchedule(task)}`);
  console.log(`  next_run:      ${task.next_run ?? '—'} (${fmtRel(task.next_run)})`);
  console.log(`  last_run:      ${task.last_run ?? '—'}${task.last_run ? ' (' + fmtRel(task.last_run) + ')' : ''}`);
  console.log(`  chat_jid:      ${task.chat_jid}`);
  console.log(`  group_folder:  ${task.group_folder}`);
  console.log(`  context_mode:  ${task.context_mode} (${modeLabel(task.context_mode)})`);
  console.log(`  created_at:    ${task.created_at}`);
  if (task.consecutive_group_missing && task.consecutive_group_missing > 0) {
    console.log(`  ⚠ group missing ticks: ${task.consecutive_group_missing}`);
  }
  console.log('');
  console.log('  prompt:');
  for (const line of task.prompt.split('\n')) {
    console.log(`    ${line}`);
  }
  if (task.script) {
    console.log('');
    console.log('  script:');
    for (const line of task.script.split('\n')) {
      console.log(`    ${line}`);
    }
  }
  console.log('');
  console.log(`  recent runs (last ${logs.length}):`);
  if (logs.length === 0) {
    console.log('    (none)');
  } else {
    for (const log of logs) {
      const ms = log.duration_ms;
      console.log(
        `    ${log.run_at}  ${log.status.padEnd(7)} ${ms}ms  ${log.error ? 'ERR: ' + previewPrompt(log.error, 60) : log.result ? previewPrompt(log.result, 60) : ''}`,
      );
    }
  }
}

interface AddTaskOpts {
  chat?: string;
  prompt?: string;
  scheduleType?: string;
  scheduleValue?: string;
  contextMode?: string;
  customId?: string;
  json: boolean;
}

/**
 * `nanoclaw task add` — host-side task creation, no chat needed.
 *
 * Mirrors the validation in `container/agent-runner-{ghc,}/src/mcp-tools/
 * scheduling.ts` (`schedule_task` MCP tool) so admin-driven creation has
 * exactly the same guarantees as agent-driven creation:
 *   - cron expressions parse with cron-parser
 *   - interval is a positive integer (ms)
 *   - once is a parseable local timestamp (no Z suffix)
 *   - chat_jid must resolve to a registered group
 *
 * Picked up by the running daemon's scheduler loop on the next tick
 * (~10s). Same DB row, same lifecycle as MCP-created tasks.
 */
async function addTask(opts: AddTaskOpts): Promise<void> {
  const errors: string[] = [];
  if (!opts.chat) errors.push('--chat <jid> is required');
  if (!opts.prompt) errors.push('--prompt <text> is required');
  if (!opts.scheduleType) errors.push('--schedule-type <cron|interval|once> is required');
  if (!opts.scheduleValue) errors.push('--schedule-value <v> is required');
  if (errors.length) {
    for (const e of errors) console.error(e);
    console.error('');
    console.error("Run 'nanoclaw task --help' for full usage.");
    process.exitCode = 1;
    return;
  }

  const scheduleType = opts.scheduleType as string;
  if (scheduleType !== 'cron' && scheduleType !== 'interval' && scheduleType !== 'once') {
    console.error(`Invalid --schedule-type: ${scheduleType}. Must be cron|interval|once.`);
    process.exitCode = 1;
    return;
  }

  const contextMode = opts.contextMode || 'isolated';
  if (contextMode !== 'group' && contextMode !== 'isolated') {
    console.error(`Invalid --context-mode: ${contextMode}. Must be group|isolated.`);
    process.exitCode = 1;
    return;
  }

  const group = getRegisteredGroup(opts.chat as string);
  if (!group) {
    console.error(`No registered group found for chat_jid: ${opts.chat}`);
    console.error('');
    console.error('Registered groups:');
    const all = getAllRegisteredGroups();
    for (const [jid, g] of Object.entries(all)) {
      console.error(`  ${jid}  folder=${g.folder}`);
    }
    if (Object.keys(all).length === 0) {
      console.error('  (none) — register a chat first via the daemon (chat must say something).');
    }
    process.exitCode = 1;
    return;
  }

  let nextRun: string | null = null;
  const scheduleValue = opts.scheduleValue as string;
  if (scheduleType === 'cron') {
    try {
      const it = CronExpressionParser.parse(scheduleValue);
      nextRun = it.next().toISOString();
    } catch {
      console.error(`Invalid cron expression: "${scheduleValue}".`);
      console.error("  Examples: '0 9 * * *' (daily 9am), '*/5 * * * *' (every 5 min).");
      process.exitCode = 1;
      return;
    }
  } else if (scheduleType === 'interval') {
    const ms = parseInt(scheduleValue, 10);
    if (!Number.isFinite(ms) || ms <= 0) {
      console.error(`Invalid interval: "${scheduleValue}". Must be a positive integer (milliseconds).`);
      process.exitCode = 1;
      return;
    }
    nextRun = new Date(Date.now() + ms).toISOString();
  } else {
    if (scheduleValue.endsWith('Z')) {
      console.error(`Invalid once timestamp: "${scheduleValue}". Drop the trailing Z — use local time.`);
      process.exitCode = 1;
      return;
    }
    const date = new Date(scheduleValue);
    if (isNaN(date.getTime())) {
      console.error(`Invalid once timestamp: "${scheduleValue}". Use format like '2026-02-01T15:30:00'.`);
      process.exitCode = 1;
      return;
    }
    nextRun = date.toISOString();
  }

  const id = opts.customId || `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    createTask({
      id,
      group_folder: group.folder,
      chat_jid: opts.chat as string,
      prompt: opts.prompt as string,
      script: null,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: contextMode as 'group' | 'isolated',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });
  } catch (err: any) {
    // Most likely a duplicate primary key when --id was supplied.
    // Surface a clean message instead of a raw SQLite stack trace.
    if (err && typeof err.code === 'string' && err.code.startsWith('SQLITE_CONSTRAINT')) {
      console.error(`Task id already exists: ${id}`);
      console.error('Pick a different --id, or omit --id to auto-generate.');
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  if (opts.json) {
    console.log(JSON.stringify({ id, next_run: nextRun, status: 'active' }, null, 2));
  } else {
    console.log(`✅ Created task ${id}`);
    console.log(`   chat:   ${opts.chat}  (folder: ${group.folder})`);
    console.log(`   schedule: ${scheduleType}=${scheduleValue}`);
    console.log(`   context_mode: ${contextMode}`);
    console.log(`   next_run: ${nextRun || '(none)'}`);
    console.log('');
    console.log('   The running daemon will pick it up on the next scheduler tick (~10s).');
  }
}

function printUsage(): void {
  console.log('Usage: nanoclaw task <list|info|add> [args]');
  console.log('');
  console.log('Commands:');
  console.log('  list                       List all scheduled tasks');
  console.log('       --chat <jid>            Filter by chat_jid');
  console.log('       --status <s>            Filter by status (active|paused|completed)');
  console.log('       --json                  Emit JSON instead of human format');
  console.log('  info <id>                  Show full task + recent run logs');
  console.log('       --json                  Emit JSON instead of human format');
  console.log('  add                        Create a new scheduled task (host-side, no chat needed)');
  console.log('       --chat <jid>            Required: target chat_jid (must be a registered group)');
  console.log('       --prompt <text>         Required: what the agent should do when the task fires');
  console.log('       --schedule-type <t>     Required: cron | interval | once');
  console.log(
    '       --schedule-value <v>    Required: cron expr | interval ms | local ISO timestamp (no Z; e.g. 2026-02-01T15:30:00)',
  );
  console.log('       --context-mode <m>      Optional: group | isolated (default: isolated)');
  console.log('       --id <custom-id>        Optional: custom task id (default: task-<ts>-<rand>)');
  console.log('       --json                  Emit JSON (id + next_run) instead of human format');
  console.log('');
  console.log('Notes:');
  console.log('  - `list` defaults to *all* tasks across every chat.');
  console.log('    The in-chat `/tasks` slash still filters to the calling chat.');
  console.log('  - `add` writes directly to the SQLite store. Picked up on the next');
  console.log('    scheduler tick (~10s). For agent-driven creation prefer the');
  console.log('    `schedule_task` MCP tool from inside chat — same DB row, same');
  console.log('    validation, plus access to chat context.');
}

function parseFlags(args: string[]): {
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

export async function runTaskCommand(args: string[]): Promise<void> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h') {
    printUsage();
    return;
  }
  // Open the shared SQLite handle. Idempotent + cheap; the daemon may
  // be running too — SQLite handles concurrent readers fine.
  initDatabase();
  const rest = args.slice(1);
  const { positional, flags } = parseFlags(rest);
  switch (sub) {
    case 'list':
    case 'ls':
      await listTasks({
        chat: typeof flags.chat === 'string' ? flags.chat : undefined,
        status: typeof flags.status === 'string' ? flags.status : undefined,
        json: flags.json === true,
      });
      return;
    case 'info':
    case 'show':
      if (!positional[0]) {
        console.error('Usage: nanoclaw task info <id>');
        process.exitCode = 1;
        return;
      }
      await infoTask(positional[0], { json: flags.json === true });
      return;
    case 'add':
    case 'create':
      await addTask({
        chat: typeof flags.chat === 'string' ? flags.chat : undefined,
        prompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
        scheduleType: typeof flags['schedule-type'] === 'string' ? (flags['schedule-type'] as string) : undefined,
        scheduleValue: typeof flags['schedule-value'] === 'string' ? (flags['schedule-value'] as string) : undefined,
        contextMode: typeof flags['context-mode'] === 'string' ? (flags['context-mode'] as string) : undefined,
        customId: typeof flags.id === 'string' ? (flags.id as string) : undefined,
        json: flags.json === true,
      });
      return;
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
