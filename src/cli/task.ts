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
} from '../db.js';
import { ScheduledTask } from '../types.js';

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

async function listTasks(opts: {
  chat?: string;
  status?: string;
  json?: boolean;
}): Promise<void> {
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

  if (rows.length === 0) {
    const filterBits: string[] = [];
    if (opts.chat) filterBits.push(`chat=${opts.chat}`);
    if (opts.status) filterBits.push(`status=${opts.status}`);
    const filter = filterBits.length ? ` (${filterBits.join(', ')})` : '';
    console.log(`No scheduled tasks${filter}.`);
    return;
  }

  // Header summary
  const counts = rows.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  console.log(`${rows.length} task${rows.length === 1 ? '' : 's'} (${summary})`);
  console.log('');

  for (const t of rows) {
    const lines: string[] = [];
    lines.push(`• ${t.id}`);
    lines.push(
      `    ${t.status.padEnd(9)} ${fmtSchedule(t).padEnd(22)} next: ${
        t.next_run ?? '—'
      } (${fmtRel(t.next_run)})`,
    );
    lines.push(
      `    chat:${t.chat_jid}  group:${t.group_folder}  ctx:${t.context_mode}`,
    );
    if (t.last_run) {
      lines.push(
        `    last: ${t.last_run} (${fmtRel(t.last_run)})${
          t.last_result ? '  — ' + previewPrompt(t.last_result, 50) : ''
        }`,
      );
    }
    if (t.consecutive_group_missing && t.consecutive_group_missing > 0) {
      lines.push(
        `    ⚠ group missing for ${t.consecutive_group_missing} tick(s)`,
      );
    }
    lines.push(`    prompt: ${previewPrompt(t.prompt, 80)}`);
    console.log(lines.join('\n'));
    console.log('');
  }
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
  console.log(`  context_mode:  ${task.context_mode}`);
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

function printUsage(): void {
  console.log('Usage: nanoclaw task <list|info> [args]');
  console.log('');
  console.log('Commands:');
  console.log('  list                       List all scheduled tasks');
  console.log('       --chat <jid>            Filter by chat_jid');
  console.log('       --status <s>            Filter by status (active|paused|completed)');
  console.log('       --json                  Emit JSON instead of human format');
  console.log('  info <id>                  Show full task + recent run logs');
  console.log('       --json                  Emit JSON instead of human format');
  console.log('');
  console.log('Notes:');
  console.log('  - `list` defaults to *all* tasks across every chat.');
  console.log('    The in-chat `/tasks` slash still filters to the calling chat.');
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
    default:
      console.error(`Unknown subcommand: ${sub}`);
      printUsage();
      process.exitCode = 1;
  }
}
