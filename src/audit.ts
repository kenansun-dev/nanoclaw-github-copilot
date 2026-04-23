/**
 * Audit logging — records sensitive config mutations with caller context.
 *
 * Today: writes to the same daily log sink as logger (`nanoclaw-YYYY-MM-DD.log`)
 * so all events stay in one place. Tagged with `AUDIT` for grep.
 *
 * Future: swap the internal sink (`writeAuditLine`) to a dedicated
 * `nanoclaw-audit-YYYY-MM-DD.log` or external store without touching callers.
 *
 * Why audit exists separately from logger:
 *   - Audit events must always fire regardless of `logLevel` (info/warn/error).
 *     A user setting `logLevel=error` should NOT hide config mutations.
 *   - Audit events have a structured shape (subject + before + after + source)
 *     vs logger's free-form key=value pairs.
 *   - Future: separate retention policy (audit kept 90 days, logs 7 days).
 */

import { logger } from './logger.js';

/** A single audit event payload. */
export interface AuditEvent {
  /** Stable event id, e.g. "config.thinkLevel.changed". */
  event: string;
  /** Path that changed, e.g. "agents.defaults.thinkLevel". */
  subject: string;
  /** Value before change (may be undefined if newly set). */
  before: unknown;
  /** Value after change (may be undefined if deleted). */
  after: unknown;
  /** Where the change came from (slash command, CLI, code path). */
  source: AuditSource;
  /** Optional context (chatJid, userId, commandLine, etc.). */
  context?: Record<string, unknown>;
}

/** Origin of a config mutation. Add new sources here as new entry points appear. */
export type AuditSource =
  | 'slash-command' // /think, /reasoning in chat
  | 'tui' // interactive TUI
  | 'cli' // `nanoclaw <subcommand>`
  | 'ipc-agent' // agent inside container called nanoclaw_control set_config
  | 'chat-manager' // chat add/remove/reconcile
  | 'migration' // configVersion bump on load
  | 'secret-migration' // plaintext → ${ENV_VAR}
  | 'unknown'; // fallback when caller didn't pass source

/**
 * Record an audit event. Always writes regardless of log level.
 *
 * Sink isolation: this is the ONLY place that decides where audit lines go.
 * Callers must not invoke `logger.*` directly for audit purposes.
 */
export function auditLog(event: AuditEvent): void {
  writeAuditLine(event);
}

/** Internal sink. Today: piggyback on logger.info with AUDIT tag. */
function writeAuditLine(event: AuditEvent): void {
  // Render before/after compactly for grep readability
  const beforeStr = renderValue(event.before);
  const afterStr = renderValue(event.after);
  const ctxStr = event.context ? ` ctx=${JSON.stringify(event.context)}` : '';
  // Use logger.warn so it survives logLevel=warn|error too. (logLevel=info
  // is the default; warn is a safer floor for audit.)
  logger.warn(
    {
      audit: true,
      event: event.event,
      subject: event.subject,
      before: beforeStr,
      after: afterStr,
      source: event.source,
      ...(event.context ? { ctx: event.context } : {}),
    },
    `AUDIT ${event.event} ${event.subject}: ${beforeStr} → ${afterStr} (source=${event.source})${ctxStr}`,
  );
}

function renderValue(v: unknown): string {
  if (v === undefined) return '<unset>';
  if (v === null) return '<null>';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return '<unstringifiable>';
  }
}

// ─── Helpers for common subjects ────────────────────────────────────────────

/**
 * Diff two config snapshots and emit one audit event per watched field that
 * changed. Keeps watch list central so adding a new audited field is one line.
 *
 * Watched fields (initial set, expand as needed):
 *   - agents.defaults.thinkLevel
 *   - agents.defaults.model
 *   - agents.defaults.provider
 *   - agents.defaults.triggerWord
 *   - agents.defaults.mode
 *   - agents.defaults.showThinking
 */
const WATCHED_PATHS: readonly string[] = [
  'agents.defaults.thinkLevel',
  'agents.defaults.model',
  'agents.defaults.provider',
  'agents.defaults.triggerWord',
  'agents.defaults.mode',
  'agents.defaults.showThinking',
];

export function auditConfigDiff(
  before: unknown,
  after: unknown,
  source: AuditSource,
  context?: Record<string, unknown>,
): void {
  for (const path of WATCHED_PATHS) {
    const b = getPath(before, path);
    const a = getPath(after, path);
    if (!equalValues(b, a)) {
      auditLog({
        event: 'config.changed',
        subject: path,
        before: b,
        after: a,
        source,
        context,
      });
    }
  }
}

function getPath(obj: unknown, dotPath: string): unknown {
  if (!obj || typeof obj !== 'object') return undefined;
  let cur: any = obj;
  for (const key of dotPath.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[key];
  }
  return cur;
}

function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  // For primitives, ===; for objects, JSON shape compare (good enough for audit)
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}
