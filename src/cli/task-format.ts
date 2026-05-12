/**
 * Shared task-list renderer (PR #46, 2026-05-12).
 *
 * Single source of truth for "what does a list of scheduled_tasks look
 * like as text". Used by:
 *   \u2022 `nanoclaw task list` CLI       \u2014 src/cli/task.ts
 *   \u2022 `list_tasks` MCP tool         \u2014 container/agent-runner-ghc/src/mcp-tools/scheduling.ts
 *   \u2022 `/tasks` slash command renders via the agent's MCP call, so it
 *     also flows through this formatter (modulo agent restyling).
 *
 * Why one formatter: previously CLI and MCP each rendered tasks
 * independently \u2014 CLI showed `ctx:group` field, MCP omitted it entirely.
 * That's why kenan saw no standalone/attached info in `/tasks`. Same
 * pattern as `/status` slash, which already shares `getStatusText()`
 * between CLI and chat (see slash-commands.ts:217).
 *
 * NOTE: a verbatim copy of this file lives at
 *   container/agent-runner-ghc/src/cli-shared/task-format.ts
 * because the container build (rootDir=container/agent-runner-ghc/src)
 * cannot import from the host's src/ tree. If you change one, change
 * the other. Keep the two in lockstep \u2014 there's a smoke test that
 * diff-checks them at CI time.
 */

export interface TaskRow {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  last_run?: string | null;
  last_result?: string | null;
  status: string;
  context_mode?: string | null;
  consecutive_group_missing?: number | null;
}

export interface FormatOpts {
  /** When true, omit verbose chat/group lines \u2014 used by MCP `list_tasks`
   * which already filters to one chat. CLI defaults to verbose. */
  compact?: boolean;
  /** Filter description for the empty-state message ("No tasks (chat=X)"). */
  filterDesc?: string;
}

/** Translate internal `context_mode` to the user-facing label. */
export function modeLabel(contextMode: string | null | undefined): string {
  // Forward-compat: anything not 'group' is treated as standalone (the
  // current default). 'group' \u2192 attached. Unknown values are reported
  // as-is so we surface drift instead of hiding it.
  if (!contextMode || contextMode === 'isolated') return 'standalone';
  if (contextMode === 'group') return 'attached';
  return contextMode;
}

function fmtRel(iso: string | null | undefined): string {
  if (!iso) return '\u2014';
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

function fmtSchedule(t: TaskRow): string {
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
  return oneLine.slice(0, max - 1) + '\u2026';
}

/**
 * Render a list of scheduled tasks to plain text. Pure function:
 * deterministic given (rows, opts), no I/O.
 */
export function formatTasksText(rows: TaskRow[], opts: FormatOpts = {}): string {
  if (rows.length === 0) {
    const filter = opts.filterDesc ? ` (${opts.filterDesc})` : '';
    return `No scheduled tasks${filter}.`;
  }

  const out: string[] = [];

  // Header summary
  const counts = rows.reduce<Record<string, number>>((acc, t) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});
  const summary = Object.entries(counts)
    .map(([k, v]) => `${k}=${v}`)
    .join(' ');
  out.push(`${rows.length} task${rows.length === 1 ? '' : 's'} (${summary})`);
  out.push('');

  for (const t of rows) {
    const mode = modeLabel(t.context_mode);
    out.push(`\u2022 ${t.id}`);
    out.push(
      `    ${t.status.padEnd(9)} ${fmtSchedule(t).padEnd(22)} mode:${mode.padEnd(10)} next: ${t.next_run ?? '\u2014'} (${fmtRel(t.next_run)})`,
    );
    if (!opts.compact) {
      out.push(`    chat:${t.chat_jid}  group:${t.group_folder}`);
    }
    if (t.last_run) {
      const tail = t.last_result ? '  \u2014 ' + previewPrompt(t.last_result, 50) : '';
      out.push(`    last: ${t.last_run} (${fmtRel(t.last_run)})${tail}`);
    }
    if (t.consecutive_group_missing && t.consecutive_group_missing > 0) {
      out.push(`    \u26a0 group missing for ${t.consecutive_group_missing} tick(s)`);
    }
    out.push(`    prompt: ${previewPrompt(t.prompt, 80)}`);
    out.push('');
  }

  return out.join('\n').trimEnd();
}
