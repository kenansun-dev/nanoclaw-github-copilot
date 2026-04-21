import fs from 'fs';
import path from 'path';
import { createGzip } from 'zlib';
import { pipeline } from 'stream/promises';
import os from 'os';

const LEVELS = {
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;
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

const VALID_LEVELS: readonly Level[] = [
  'debug',
  'info',
  'warn',
  'error',
  'fatal',
] as const;

function parseLevel(value: string | undefined | null): Level | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase() as Level;
  return VALID_LEVELS.includes(normalized) ? normalized : undefined;
}

// Mutable threshold so it can be changed at runtime (see setLogLevel).
// Initial value: env LOG_LEVEL takes priority, else 'info'.
// On startup, applyConfigLogLevel() may bump it to config.logLevel when
// env LOG_LEVEL is unset (env always wins as a manual override).
let currentLevel: Level = parseLevel(process.env.LOG_LEVEL) ?? 'info';
let envLevelLocked = parseLevel(process.env.LOG_LEVEL) !== undefined;

function threshold(): number {
  return LEVELS[currentLevel];
}

/** Returns the currently active log level. */
export function getLogLevel(): Level {
  return currentLevel;
}

/** Returns the list of valid log level names. */
export function getValidLevels(): readonly Level[] {
  return VALID_LEVELS;
}

/**
 * Change the log level at runtime. Intended for the `nanoclaw loglevel`
 * CLI / SIGUSR2 reload path. Returns the level that was applied (which
 * may differ from the requested value if env LOG_LEVEL is locked).
 */
export function setLogLevel(
  level: string,
  opts: { force?: boolean } = {},
): { applied: Level; locked: boolean } {
  const parsed = parseLevel(level);
  if (!parsed) {
    throw new Error(
      `Invalid log level: ${level}. Valid: ${VALID_LEVELS.join(', ')}`,
    );
  }
  // env LOG_LEVEL is treated as a manual override; don't let config or
  // runtime calls silently undo it unless caller explicitly forces.
  if (envLevelLocked && !opts.force) {
    return { applied: currentLevel, locked: true };
  }
  if (opts.force) envLevelLocked = false;
  currentLevel = parsed;
  return { applied: parsed, locked: false };
}

/**
 * Apply config.logLevel at startup. No-op if env LOG_LEVEL is set
 * (env wins as manual override) or if config value is invalid/missing.
 * Safe to call multiple times (e.g. on reloadConfig).
 */
export function applyConfigLogLevel(configLevel: string | undefined): void {
  if (envLevelLocked) return;
  const parsed = parseLevel(configLevel);
  if (parsed) currentLevel = parsed;
}

const stdoutIsTTY = process.stdout.isTTY === true;
const stderrIsTTY = process.stderr.isTTY === true;

// ─── Token scrubbing ─────────────────────────────────────────────────────────

const TOKEN_PATTERNS = [
  /\b(gho_)\w{4}\w+/g,
  /\b(ghu_)\w{4}\w+/g,
  /\b(ghs_)\w{4}\w+/g,
  /\b(ghp_)\w{4}\w+/g,
  /\b(github_pat_)\w{4}\w+/g,
  /(Bearer )\S{8}\S+/g,
  /(token=)\S{8}\S+/gi,
];

function scrubTokens(text: string): string {
  if (!text) return text || '';
  let result = text;
  for (const pattern of TOKEN_PATTERNS) {
    result = result.replace(pattern, (match, prefix) => {
      return `${prefix}****`;
    });
  }
  return result;
}

// ─── Formatting ──────────────────────────────────────────────────────────────

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || err.message;
  }
  return JSON.stringify(err);
}

function formatData(data: Record<string, unknown>, useColor: boolean): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      // Stack traces stay multi-line
      const errText = scrubTokens(formatErr(v));
      out += useColor
        ? `\n    ${KEY_COLOR}err${RESET}: ${errText}`
        : `\n    err: ${errText}`;
    } else {
      const raw =
        v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
      const val = scrubTokens(raw);
      out += useColor ? ` ${KEY_COLOR}${k}${RESET}=${val}` : ` ${k}=${val}`;
    }
  }
  return out;
}

function ts(): string {
  return new Date().toISOString();
}

// ─── File logging (daily rotation) ───────────────────────────────────────────

const LOG_DIR = path.join(os.homedir(), '.nanoclaw', 'logs');
const ARCHIVE_DAYS = 7;
let currentLogDate = '';
let logStream: fs.WriteStream | null = null;

function getLogDate(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function ensureLogStream(): fs.WriteStream | null {
  try {
    const today = getLogDate();
    if (logStream && currentLogDate === today) return logStream;

    // Close old stream
    if (logStream) {
      logStream.end();
      logStream = null;
    }

    fs.mkdirSync(LOG_DIR, { recursive: true });
    currentLogDate = today;
    const logFile = path.join(LOG_DIR, `nanoclaw-${today}.log`);
    logStream = fs.createWriteStream(logFile, { flags: 'a' });
    return logStream;
  } catch {
    return null;
  }
}

// Archive logs older than ARCHIVE_DAYS (gzip, keep .gz)
function archiveOldLogs(): void {
  try {
    if (!fs.existsSync(LOG_DIR)) return;
    const now = Date.now();
    const cutoff = ARCHIVE_DAYS * 24 * 60 * 60 * 1000;

    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!file.startsWith('nanoclaw-') || !file.endsWith('.log')) continue;
      if (file === `nanoclaw-${getLogDate()}.log`) continue; // skip today

      const filePath = path.join(LOG_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > cutoff) {
        // Gzip archive
        const gzPath = filePath + '.gz';
        if (!fs.existsSync(gzPath)) {
          const src = fs.createReadStream(filePath);
          const dst = fs.createWriteStream(gzPath);
          const gzip = createGzip();
          pipeline(src, gzip, dst)
            .then(() => {
              fs.unlinkSync(filePath);
            })
            .catch(() => {
              /* ignore archive errors */
            });
        }
      }
    }
  } catch {
    /* ignore */
  }
}

// Run archive check once on startup
setTimeout(archiveOldLogs, 5000);

// ─── Console output control ─────────────────────────────────────────────────

let consoleOutputEnabled = true;

/** Enable or disable console (stdout/stderr) output from the logger.
 *  File logging is always active regardless of this setting.
 *  CLI commands should call setConsoleOutput(false) to avoid polluting stdout. */
export function setConsoleOutput(enabled: boolean): void {
  consoleOutputEnabled = enabled;
}

// ─── Main log function ───────────────────────────────────────────────────────

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold()) return;

  const timestamp = ts();
  const levelTag = level.toUpperCase();

  // Build plain text line (for file)
  let plainLine: string;
  if (typeof dataOrMsg === 'string') {
    plainLine = `[${timestamp}] ${levelTag} ${scrubTokens(dataOrMsg)}`;
  } else {
    const msgText = msg ? scrubTokens(msg) : '';
    plainLine = `[${timestamp}] ${levelTag} ${msgText}${formatData(dataOrMsg, false)}`;
  }

  // Write to file
  const stream = ensureLogStream();
  stream?.write(plainLine + '\n');

  // Write to console (only when enabled — CLI commands disable this)
  if (!consoleOutputEnabled) return;

  const consoleStream =
    LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const useColor = consoleStream === process.stderr ? stderrIsTTY : stdoutIsTTY;

  if (useColor) {
    const tag = `${COLORS[level]}${levelTag}${level === 'fatal' ? FULL_RESET : RESET}`;
    if (typeof dataOrMsg === 'string') {
      consoleStream.write(
        `[${timestamp}] ${tag} ${MSG_COLOR}${scrubTokens(dataOrMsg)}${RESET}\n`,
      );
    } else {
      const msgText = msg ? `${MSG_COLOR}${scrubTokens(msg)}${RESET}` : '';
      consoleStream.write(
        `[${timestamp}] ${tag} ${msgText}${formatData(dataOrMsg, true)}\n`,
      );
    }
  } else {
    consoleStream.write(plainLine + '\n');
  }
}

export const logger = {
  debug: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('debug', dataOrMsg, msg),
  info: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('info', dataOrMsg, msg),
  warn: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('warn', dataOrMsg, msg),
  error: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('error', dataOrMsg, msg),
  fatal: (dataOrMsg: Record<string, unknown> | string, msg?: string) =>
    log('fatal', dataOrMsg, msg),
};

// Route uncaught errors through logger
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
