/**
 * Daemon signal helpers — shared between CLI commands that ask the
 * running nanoclaw daemon to reload its in-memory config without restart.
 *
 * POSIX: send SIGUSR2 to the pid in `~/.nanoclaw/state/nanoclaw.pid`.
 * Windows: write a trigger file `~/.nanoclaw/state/reload.trigger` that
 *   the daemon polls and acts on, since process signals other than
 *   SIGINT/SIGTERM/SIGKILL are no-ops on Windows.
 *
 * Callers (`nanoclaw loglevel`, `nanoclaw mcp add/remove`, `nanoclaw reload`)
 * use these helpers so the pid + signal logic lives in exactly one place.
 */

import fs from 'fs';
import path from 'path';
import { paths } from './workspace.js';

export const RELOAD_TRIGGER_FILENAME = 'reload.trigger';

function stateDir(): string {
  const ws = path.dirname(paths.config);
  return path.join(ws, 'state');
}

export function pidFilePath(): string {
  return path.join(stateDir(), 'nanoclaw.pid');
}

export function reloadTriggerPath(): string {
  return path.join(stateDir(), RELOAD_TRIGGER_FILENAME);
}

/**
 * Read the daemon pid from the pidfile and verify the process is alive.
 * Returns null when the file is missing, malformed, or the pid is dead.
 */
export function readPid(): number | null {
  try {
    const pidFile = pidFilePath();
    if (!fs.existsSync(pidFile)) return null;
    const pid = parseInt(fs.readFileSync(pidFile, 'utf-8').trim(), 10);
    if (!Number.isFinite(pid) || pid <= 0) return null;
    try {
      process.kill(pid, 0);
      return pid;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

export interface ReloadResult {
  /** Reload was actually requested (signal sent or trigger written). */
  delivered: boolean;
  /** Daemon was not running (no pidfile or dead process). */
  noDaemon: boolean;
  /** Method we used: 'signal' on POSIX, 'trigger-file' on Windows. */
  method?: 'signal' | 'trigger-file';
  /** Error message when delivery failed for an unexpected reason. */
  error?: string;
  /** Pid we signaled, when applicable. */
  pid?: number;
}

/**
 * Ask the running daemon to reload its config in-memory.
 *
 * Best-effort: returns a result object instead of throwing so callers can
 * decide their own messaging (e.g. `mcp add` should not fail just because
 * the daemon happens to be stopped).
 */
export function signalReload(): ReloadResult {
  // Windows: process signals other than SIGINT/SIGTERM/SIGKILL are
  // no-ops. Use a trigger file polled by the daemon instead.
  if (process.platform === 'win32') {
    try {
      fs.mkdirSync(stateDir(), { recursive: true });
      fs.writeFileSync(reloadTriggerPath(), String(Date.now()));
      return { delivered: true, noDaemon: false, method: 'trigger-file' };
    } catch (err: any) {
      return {
        delivered: false,
        noDaemon: false,
        method: 'trigger-file',
        error: err?.message || String(err),
      };
    }
  }

  const pid = readPid();
  if (pid === null) {
    return { delivered: false, noDaemon: true, method: 'signal' };
  }
  try {
    process.kill(pid, 'SIGUSR2');
    return { delivered: true, noDaemon: false, method: 'signal', pid };
  } catch (err: any) {
    return {
      delivered: false,
      noDaemon: false,
      method: 'signal',
      pid,
      error: err?.message || String(err),
    };
  }
}
