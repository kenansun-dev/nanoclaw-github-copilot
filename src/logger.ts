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

// Detect if stdout/stderr are TTYs for color decisions
const stdoutIsTTY = process.stdout.isTTY === true;
const stderrIsTTY = process.stderr.isTTY === true;

function formatErr(err: unknown): string {
  if (err instanceof Error) {
    return err.stack || err.message;
  }
  return JSON.stringify(err);
}

function formatData(
  data: Record<string, unknown>,
  useColor: boolean,
): string {
  let out = '';
  for (const [k, v] of Object.entries(data)) {
    if (k === 'err') {
      out += useColor
        ? `\n    ${KEY_COLOR}err${RESET}: ${formatErr(v)}`
        : `\n    err: ${formatErr(v)}`;
    } else {
      const val = typeof v === 'string' ? v : JSON.stringify(v);
      out += useColor
        ? `\n    ${KEY_COLOR}${k}${RESET}: ${val}`
        : `\n    ${k}: ${val}`;
    }
  }
  return out;
}

function ts(): string {
  return new Date().toISOString();
}

function log(
  level: Level,
  dataOrMsg: Record<string, unknown> | string,
  msg?: string,
): void {
  if (LEVELS[level] < threshold) return;
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  const useColor = stream === process.stderr ? stderrIsTTY : stdoutIsTTY;
  const tag = useColor
    ? `${COLORS[level]}${level.toUpperCase()}${level === 'fatal' ? FULL_RESET : RESET}`
    : level.toUpperCase();

  if (typeof dataOrMsg === 'string') {
    const text = useColor
      ? `${MSG_COLOR}${dataOrMsg}${RESET}`
      : dataOrMsg;
    stream.write(`[${ts()}] ${tag} ${text}\n`);
  } else {
    const text = useColor
      ? `${MSG_COLOR}${msg}${RESET}`
      : (msg || '');
    stream.write(
      `[${ts()}] ${tag} ${text}${formatData(dataOrMsg, useColor)}\n`,
    );
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

// Route uncaught errors through logger so they get timestamps in stderr
process.on('uncaughtException', (err) => {
  logger.fatal({ err }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, 'Unhandled rejection');
});
