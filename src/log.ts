const LEVELS = { debug: 20, info: 30, warn: 40, error: 50, fatal: 60 } as const;
type Level = keyof typeof LEVELS;

const COLORS: Record<Level, string> = {
  debug: '\x1b[34m',
  info: '\x1b[32m',
  warn: '\x1b[33m',
  error: '\x1b[31m',
  fatal: '\x1b[41m\x1b[37m',
};
const KEY_COLOR = '\x1b[35m';
const MSG_COLOR = '\x1b[36m';
const RESET = '\x1b[39m';
const FULL_RESET = '\x1b[0m';

// Detect whether stdout/stderr are real TTYs once, at module load. When
// the daemon writes its stream to a log file (`nanoclaw start` redirects
// stdout/stderr to ~/.nanoclaw/logs/nanoclaw.log), `isTTY` is false and
// raw ANSI escapes like `\x1b[32m` end up baked into the log file. Old
// fork logger.ts (pre-v2-merge) gated colors on isTTY; v2's simplified
// log.ts dropped that. Restored 2026-05-09 (kenan regression).
const STDOUT_IS_TTY = process.stdout.isTTY === true;
const STDERR_IS_TTY = process.stderr.isTTY === true;
const NO_COLOR = process.env.NO_COLOR != null;

function useColorFor(stream: NodeJS.WriteStream): boolean {
  if (NO_COLOR) return false;
  return stream === process.stderr ? STDERR_IS_TTY : STDOUT_IS_TTY;
}

// Runtime log threshold. Fork change (2026-08-03 B3): upstream freezes
// this as a `const` read once at module load, so `nanoclaw loglevel <x>`
// (which updates the mutable level in log-extensions.ts) never actually
// changed what `emit()` gates on — a silent no-op (kenan hit this: tail
// stayed error-only after `ncl loglevel debug`). Make it a `let` and let
// `setLogThreshold` (called by log-extensions' setLogLevel/applyConfigLogLevel)
// push the effective level down so runtime changes take effect. log.ts
// does NOT import log-extensions, so no import cycle.
let threshold: number = LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

/**
 * Fork-only (B3): update the live threshold that `emit()` gates on.
 * The log-level *policy* (env-lock, force-unlock, validation) stays in
 * log-extensions.ts; this is just the downstream sink so a runtime change
 * is honored by the actual emit gate.
 */
export function setLogThreshold(level: string): void {
  const next = (LEVELS as Record<string, number>)[level];
  if (next != null) threshold = next;
}

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return `{ type: "${err.constructor.name}", message: "${err.message}", stack: ${err.stack} }`;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>, useColor: boolean): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    const valStr = k === 'err' ? formatErr(v) : JSON.stringify(v);
    parts.push(useColor ? `${KEY_COLOR}${k}${RESET}=${valStr}` : `${k}=${valStr}`);
  }
  return parts.length ? ' ' + parts.join(' ') : '';
}

function ts(): string {
  const d = new Date();
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  return `${hh}:${mm}:${ss}.${ms}`;
}

function emit(level: Level, msg: string, data?: Record<string, unknown>): void {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const useColor = useColorFor(stream);
  if (useColor) {
    const tag = `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`;
    stream.write(`[${ts()}] ${tag} ${MSG_COLOR}${msg}${RESET}${data ? formatData(data, true) : ''}\n`);
  } else {
    const tag = level.toUpperCase();
    stream.write(`[${ts()}] ${tag} ${msg}${data ? formatData(data, false) : ''}\n`);
  }
}

export const log = {
  debug: (msg: string, data?: Record<string, unknown>) => emit('debug', msg, data),
  info: (msg: string, data?: Record<string, unknown>) => emit('info', msg, data),
  warn: (msg: string, data?: Record<string, unknown>) => emit('warn', msg, data),
  error: (msg: string, data?: Record<string, unknown>) => emit('error', msg, data),
  fatal: (msg: string, data?: Record<string, unknown>) => emit('fatal', msg, data),
};

process.on('uncaughtException', (err) => {
  log.fatal('Uncaught exception', { err });
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled rejection', { err: reason });
});
