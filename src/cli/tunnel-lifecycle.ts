/**
 * Shared devtunnel lifecycle helpers.
 *
 * Before this module existed, the "start the nanoclaw devtunnel if Teams is
 * enabled" logic lived inline inside `case 'start'` in cli.ts, positioned
 * AFTER the Windows scheduled-task and systemd early-returns. That meant the
 * tunnel only auto-started on the pure direct-PID path: `nanoclaw start` via a
 * Windows scheduled task, and `nanoclaw update` (which shells out to
 * `nanoclaw start`), both skipped it. The stop-side devtunnel kill was also
 * copy-pasted in two places.
 *
 * These helpers centralize that behavior so start / restart / update all reuse
 * the same idempotent path. `ensureTunnelHosting` is safe to call
 * unconditionally: it no-ops when Teams is disabled, devtunnel is missing/not
 * logged in, or a tunnel is already hosting.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import { join } from 'path';

/**
 * Ensure the nanoclaw devtunnel is hosting when Teams is enabled.
 *
 * Idempotent + fail-soft: any missing prerequisite (Teams off, devtunnel not
 * installed / not logged in, no nanoclaw tunnel, already hosting) results in a
 * quiet no-op rather than a throw, so callers can invoke it on every start.
 */
export async function ensureTunnelHosting(ws: string): Promise<void> {
  try {
    const { loadConfig } = await import('../config-loader.js');
    const cfg = loadConfig();
    if (!cfg.channels?.teams?.enabled) return;
    // Relay/proxy transport does not use a local devtunnel. Skip when the
    // channel-level transport is proxy, or when every configured account is
    // proxy (i.e. no account still wants a tunnel).
    const teams: any = cfg.channels.teams;
    const accounts = teams.accounts || {};
    const acctList = Object.values(accounts);
    const allProxy = acctList.length > 0 && acctList.every((a: any) => a?.transport === 'proxy');
    if (teams.transport === 'proxy' || allProxy) return;

    try {
      const listOut = execSync('devtunnel list', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const tunnelLine = listOut.split('\n').find((l: string) => l.toLowerCase().includes('nanoclaw'));
      if (!tunnelLine) return;
      const idMatch = tunnelLine.match(/([a-zA-Z0-9._-]+)/);
      if (!idMatch) return;
      const tid = idMatch[1];
      const showOut = execSync(`devtunnel show ${tid}`, {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10000,
      });
      const hostCount = showOut.match(/Host connections\s*:\s*(\d+)/);
      if (hostCount && hostCount[1] !== '0') {
        console.log(`DevTunnel already hosting: ${tid}`);
        return;
      }
      console.log(`Starting devtunnel: ${tid}...`);
      const dtProc = spawn('devtunnel', ['host', tid, '--allow-anonymous'], {
        detached: true,
        stdio: 'ignore',
      });
      dtProc.unref();
      try {
        fs.writeFileSync(join(ws, 'devtunnel.pid'), String(dtProc.pid));
      } catch {
        /* pid tracking is best-effort */
      }
      console.log(`DevTunnel started (pid: ${dtProc.pid})`);
    } catch {
      // devtunnel not installed or not logged in — skip silently.
    }
  } catch {
    /* config not available */
  }
}

/**
 * Kill the devtunnel we started, if we tracked its pid. Idempotent.
 * Returns a short label for logging, or null when nothing was tracked.
 */
export function stopTrackedTunnel(ws: string, killProcess: (pid: number) => void): number | null {
  try {
    const dtPidFile = join(ws, 'devtunnel.pid');
    if (!fs.existsSync(dtPidFile)) return null;
    const dtPid = parseInt(fs.readFileSync(dtPidFile, 'utf-8').trim());
    try {
      killProcess(dtPid);
    } catch {
      /* already dead */
    }
    try {
      fs.unlinkSync(dtPidFile);
    } catch {
      /* */
    }
    return Number.isNaN(dtPid) ? null : dtPid;
  } catch {
    return null;
  }
}
