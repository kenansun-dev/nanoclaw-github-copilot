/**
 * Fork extensions to upstream `src/log.ts`.
 *
 * Keeps `src/log.ts` upstream-verbatim for cheap merges. All fork-only
 * additions live here:
 *   - `logger` shim (data-first call style for old fork callers)
 *   - mutable runtime log-level + `setLogLevel` / `applyConfigLogLevel`
 *     / `getLogLevel` / `getValidLevels` / `setConsoleOutput` surface,
 *     used by `nanoclaw loglevel` and SIGUSR2 live-reload
 *
 * History: prior to this extraction these lived inline in `src/log.ts`
 * as a "v2-merge B.0.1 compatibility shim" block. Owner asked us to
 * stop mutating upstream files in-place when an extension file would
 * do — see Q2-followup audit (P1#2) for the rationale.
 *
 * Re-export `log` from upstream so callers that want both the upstream
 * `log.X(msg, data)` API and any fork extension can import a single
 * module.
 *
 * TODO B.5: restore fork's file rotation + gzip + structured field
 * colours from the pre-v2-merge `logger.ts`. For now we accept the
 * simpler v2 stdout-only logger to unblock test suite. See git history
 * for `src/logger.ts` original impl.
 */

import { log } from './log.js';

export { log };

const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

function wrapLogger(level: Level) {
  return (dataOrMsg: Record<string, unknown> | string, msg?: string) => {
    if (typeof dataOrMsg === 'string') {
      log[level](dataOrMsg, msg ? { msg } : undefined);
    } else {
      log[level](msg ?? '', dataOrMsg);
    }
  };
}

/**
 * Fork-compatibility shim. Fork code uses pino-style data-first call:
 *   `logger.info({ key: 'val' }, 'message')`
 * Upstream `log` uses msg-first:
 *   `log.info('message', { key: 'val' })`
 * This shim accepts both styles and translates to upstream `log`.
 */
export const logger = {
  debug: wrapLogger('debug'),
  info: wrapLogger('info'),
  warn: wrapLogger('warn'),
  error: wrapLogger('error'),
  fatal: wrapLogger('fatal'),
};

// Mutable runtime log-level surface. Fork-only.
let currentLevel: string = (process.env.LOG_LEVEL ?? 'info').toLowerCase();
let envLocked: boolean = process.env.LOG_LEVEL != null;

export function applyConfigLogLevel(level?: string): void {
  if (envLocked) return;
  if (!level) return;
  const normalized = level.trim().toLowerCase();
  if (!getValidLevels().includes(normalized)) return;
  currentLevel = normalized;
}

export function getLogLevel(): string {
  return currentLevel;
}

export function setConsoleOutput(_enabled: boolean): void {
  /* noop pending B.5 */
}

/** Valid log level names (compat with fork's old logger.ts surface). */
export function getValidLevels(): readonly string[] {
  return ['debug', 'info', 'warn', 'error', 'fatal'];
}

/** Set log level at runtime. Fork-only — used by `nanoclaw loglevel`. */
export function setLogLevel(level: string, opts?: { force?: boolean }): void {
  const normalized = (level ?? '').trim().toLowerCase();
  const valid = getValidLevels();
  if (!valid.includes(normalized)) {
    throw new Error(`Invalid log level: ${level}. Valid levels: ${valid.join(', ')}`);
  }
  if (opts?.force) {
    envLocked = false;
  }
  if (envLocked) return;
  currentLevel = normalized;
}
