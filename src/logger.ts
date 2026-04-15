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

const threshold =
  LEVELS[(process.env.LOG_LEVEL as Level) || 'info'] ?? LEVELS.info;

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

// ─── Main log function ───────────────────────────────────────────────────────

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;

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

  // Write to console (with colors if TTY)
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
