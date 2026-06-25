import { execFile } from 'child_process';
import fs from 'fs';
import path from 'path';

import { logger } from './log-extensions.js';

const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours
const SCRIPT_PATH = path.resolve(process.cwd(), 'scripts/cleanup-sessions.sh');
const BASH_PATH = '/bin/bash';

/**
 * The cleanup routine is a bash script (find/du/sqlite3/wc). On hosts without
 * a POSIX shell at /bin/bash (notably Windows) it cannot run, and execFile
 * would otherwise throw `spawn /bin/bash ENOENT` every cycle — harmless but it
 * spammed the log as an ERROR (see kesu's Windows host, 2026-06-25).
 *
 * Until the script is ported to cross-platform Node (TODO), skip gracefully on
 * platforms without bash: log once at startup as INFO, then no-op. Session
 * artifacts simply aren't pruned there yet.
 */
function bashAvailable(): boolean {
  if (process.platform === 'win32') return false;
  try {
    fs.accessSync(BASH_PATH, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function runCleanup(): void {
  execFile(BASH_PATH, [SCRIPT_PATH], { timeout: 60_000 }, (err, stdout) => {
    if (err) {
      logger.error({ err }, 'Session cleanup failed');
      return;
    }
    const summary = stdout.trim().split('\n').pop();
    if (summary) logger.info(summary);
  });
}

export function startSessionCleanup(): void {
  if (!bashAvailable()) {
    logger.info(
      { platform: process.platform },
      'Session cleanup skipped: no /bin/bash on this host (script-based cleanup unavailable; TODO port to Node)',
    );
    return;
  }
  // Run once at startup (delayed 30s to not compete with init)
  setTimeout(runCleanup, 30_000);
  // Then every 24 hours
  setInterval(runCleanup, CLEANUP_INTERVAL);
}
