/**
 * File logging sink with daily rotation + gzip archive + token scrub.
 *
 * v2-merge B.0 dropped file logging when it renamed `logger.ts → log.ts`
 * (kept upstream-verbatim, no file writes). The TODO B.5 in
 * `log-extensions.ts` flagged this as a regression to restore. This
 * module is that B.5 restore.
 *
 * Strategy: install a stdout/stderr write proxy that mirrors any
 * timestamped log line ("[HH:MM:SS.mmm] LEVEL ...") to the daily log
 * file. Non-log writes pass through unchanged.
 *
 * File path: `<workspace>/logs/nanoclaw-YYYY-MM-DD.log`
 * Archive: gzip files older than ARCHIVE_DAYS, keep .gz forever (cheap).
 *
 * Idempotent: calling `installFileLogSink()` twice is a no-op.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

import { workspacePath } from './workspace.js';

const ARCHIVE_DAYS = 7;
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
// Recognises lines emitted by `log.ts emit()`: "[HH:MM:SS.mmm] LEVEL <msg>"
const LOG_LINE_RE = /^\[\d{2}:\d{2}:\d{2}\.\d{3}\] /;

// Token scrub patterns — keep in sync with what we don't want hitting
// disk (Copilot/GH/Bearer/PAT shapes).
const SCRUB_PATTERNS: Array<[RegExp, string]> = [
  [/gho_[A-Za-z0-9_]+/g, 'gho_****'],
  [/ghu_[A-Za-z0-9_]+/g, 'ghu_****'],
  [/ghs_[A-Za-z0-9_]+/g, 'ghs_****'],
  [/ghp_[A-Za-z0-9_]+/g, 'ghp_****'],
  [/github_pat_[A-Za-z0-9_]+/g, 'github_pat_****'],
  [/Bearer\s+[A-Za-z0-9._\-+/=]+/g, 'Bearer ****'],
];

let installed = false;
let currentDate = '';
let currentStream: fs.WriteStream | null = null;
let logDir = '';

function todayUtc(): string {
  // Local-date file naming matches the existing v1 scheme
  // (`nanoclaw-2026-05-07.log` was written in local time on owner's box).
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

function ensureStream(): fs.WriteStream | null {
  try {
    const day = todayUtc();
    if (currentStream && currentDate === day) return currentStream;
    if (currentStream) {
      try {
        currentStream.end();
      } catch {
        /* ignore */
      }
    }
    if (!logDir) {
      logDir = workspacePath('logs');
    }
    fs.mkdirSync(logDir, { recursive: true });
    currentDate = day;
    const file = path.join(logDir, `nanoclaw-${day}.log`);
    currentStream = fs.createWriteStream(file, { flags: 'a' });
    currentStream.on('error', () => {
      // Detach on error so we don't keep crashing on every write.
      try {
        currentStream?.end();
      } catch {
        /* ignore */
      }
      currentStream = null;
    });
    // Best-effort archive sweep on rotation.
    queueMicrotask(() => archiveOldLogs());
    return currentStream;
  } catch {
    return null;
  }
}

function archiveOldLogs(): void {
  try {
    if (!fs.existsSync(logDir)) return;
    const cutoff = Date.now() - ARCHIVE_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(logDir)) {
      if (!name.startsWith('nanoclaw-') || !name.endsWith('.log')) continue;
      const full = path.join(logDir, name);
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.mtimeMs > cutoff) continue;
      try {
        const data = fs.readFileSync(full);
        fs.writeFileSync(`${full}.gz`, zlib.gzipSync(data));
        fs.unlinkSync(full);
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function scrub(s: string): string {
  let out = s;
  for (const [re, rep] of SCRUB_PATTERNS) out = out.replace(re, rep);
  return out;
}

function writeToFile(chunk: string): void {
  if (!LOG_LINE_RE.test(chunk)) return;
  const stream = ensureStream();
  if (!stream) return;
  // Strip ANSI for file output; keep colors only on console.
  const clean = scrub(chunk.replace(ANSI_RE, ''));
  try {
    stream.write(clean);
  } catch {
    /* ignore */
  }
}

function wrap(orig: typeof process.stdout.write): typeof process.stdout.write {
  // We only handle the (chunk[, encoding][, cb]) overloads; that is what
  // `log.ts emit()` uses. Other call shapes pass through unchanged.
  return function patched(this: unknown, chunk: unknown, ...rest: unknown[]) {
    try {
      if (typeof chunk === 'string') {
        writeToFile(chunk);
      } else if (Buffer.isBuffer(chunk)) {
        writeToFile(chunk.toString('utf8'));
      }
    } catch {
      /* never let logging crash the host */
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (orig as any).call(this, chunk, ...rest);
  } as typeof process.stdout.write;
}

/**
 * Install stdout/stderr proxy. Safe to call repeatedly. Returns the
 * resolved log file path, or `null` when the workspace isn't writable.
 */
export function installFileLogSink(): string | null {
  if (installed) {
    return currentStream ? path.join(logDir, `nanoclaw-${currentDate}.log`) : null;
  }
  installed = true;
  process.stdout.write = wrap(process.stdout.write.bind(process.stdout));
  process.stderr.write = wrap(process.stderr.write.bind(process.stderr));
  const stream = ensureStream();
  return stream ? path.join(logDir, `nanoclaw-${currentDate}.log`) : null;
}

/** For tests / manual diagnostics. */
export function currentLogFile(): string | null {
  if (!currentStream) return null;
  return path.join(logDir, `nanoclaw-${currentDate}.log`);
}

/**
 * Path of today's log file (whether or not the sink is installed).
 *
 * Used by `nanoclaw status`, `nanoclaw logs`, and `nanoclaw start` to
 * report / tail / redirect to the same daily file the in-process sink
 * writes to. Computes the path purely from today's local date + the
 * workspace `logs/` directory; does not touch the filesystem and does
 * not install the sink.
 */
export function expectedLogFile(): string {
  const dir = logDir || workspacePath('logs');
  return path.join(dir, `nanoclaw-${todayUtc()}.log`);
}

/** Legacy single-file log path (pre-B.5). Kept for fallback / docs. */
export function legacyLogFile(): string {
  return workspacePath('logs', 'nanoclaw.log');
}
