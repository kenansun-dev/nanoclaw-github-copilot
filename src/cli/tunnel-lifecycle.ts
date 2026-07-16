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
 *
 * OBSERVABILITY (2026-07-16, kenan): every skip path used to `return` silently
 * and the devtunnel error was swallowed by a bare `catch {}`. So when the very
 * first `devtunnel list` after a machine reboot came back cold (auth refresh +
 * .NET warmup can exceed the 10s timeout, or error transiently), `nanoclaw
 * start` printed nothing about the tunnel and it simply never came up until a
 * second start. "Started but printed nothing" is itself a bug. Now every
 * outcome prints a reason, and the cold first call is retried once with a
 * longer timeout so a warm-up hiccup no longer costs an entire start.
 */
import { execSync, spawn } from 'child_process';
import fs from 'fs';
import { join } from 'path';

export interface EnsureTunnelOptions {
  /** Delay before retrying a cold `devtunnel list`. Overridable for tests. */
  retryDelayMs?: number;
}

function firstLine(err: any): string {
  return (err?.stderr || err?.message || String(err)).toString().trim().split('\n')[0] || 'unknown error';
}

/**
 * Ensure the nanoclaw devtunnel is hosting when Teams is enabled.
 *
 * Fail-soft: any missing prerequisite (devtunnel not installed / not logged in,
 * no nanoclaw tunnel, already hosting) results in a no-op rather than a throw,
 * so callers can invoke it on every start. Unlike the old version, each no-op
 * now logs *why* so the operator is never left guessing after a silent skip.
 */
export async function ensureTunnelHosting(ws: string, opts: EnsureTunnelOptions = {}): Promise<void> {
  const retryDelayMs = opts.retryDelayMs ?? 2000;

  let cfg: any;
  try {
    const { loadConfig } = await import('../config-loader.js');
    cfg = loadConfig();
  } catch (err: any) {
    console.log(`[tunnel] skipped: could not load config (${firstLine(err)})`);
    return;
  }

  // Teams disabled is a normal, permanent config state for Telegram/Discord-only
  // users, so keep it quiet by default (avoid noise on every start). The
  // teams-enabled paths below are the ones that must never fail silently.
  if (!cfg.channels?.teams?.enabled) {
    if (process.env.NANOCLAW_TUNNEL_DEBUG) console.log('[tunnel] skipped: Teams channel disabled');
    return;
  }

  // Relay/proxy transport does not use a local devtunnel. Skip when the
  // channel-level transport is proxy, or when every configured account is proxy
  // (i.e. no account still wants a tunnel).
  const teams: any = cfg.channels.teams;
  const accounts = teams.accounts || {};
  const acctList = Object.values(accounts);
  const allProxy = acctList.length > 0 && acctList.every((a: any) => a?.transport === 'proxy');
  if (teams.transport === 'proxy' || allProxy) {
    console.log('[tunnel] skipped: Teams transport is proxy/relay (no local devtunnel needed)');
    return;
  }

  // `devtunnel list` — retry once. The first CLI invocation after a reboot is
  // cold and can time out or transiently error; a silent skip here is exactly
  // the reported bug. Attempt 1 uses the normal timeout, attempt 2 a longer one.
  let listOut: string | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      listOut = execSync('devtunnel list', {
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: attempt === 1 ? 12000 : 25000,
      });
      break;
    } catch (err: any) {
      const reason = firstLine(err);
      if (attempt === 1) {
        console.log(`[tunnel] "devtunnel list" failed on first try (cold start?), retrying once: ${reason}`);
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs));
      } else {
        console.log(
          `[tunnel] NOT hosting: "devtunnel list" failed twice (${reason}). ` +
            `Is devtunnel installed and logged in? Try: devtunnel user login`,
        );
        return;
      }
    }
  }
  if (listOut == null) return;

  const tunnelLine = listOut.split('\n').find((l: string) => l.toLowerCase().includes('nanoclaw'));
  if (!tunnelLine) {
    console.log('[tunnel] NOT hosting: no "nanoclaw" tunnel found in `devtunnel list`. Run: nanoclaw tunnel setup');
    return;
  }
  const idMatch = tunnelLine.match(/([a-zA-Z0-9._-]+)/);
  if (!idMatch) {
    console.log(`[tunnel] NOT hosting: could not parse tunnel id from list line: ${tunnelLine.trim()}`);
    return;
  }
  const tid = idMatch[1];

  // Check current hosting state. If this errors we log it and skip starting a
  // host rather than risk a duplicate host process — the list retry above has
  // already warmed the CLI, so a failure here is a genuine anomaly worth seeing.
  let showOut = '';
  try {
    showOut = execSync(`devtunnel show ${tid}`, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 15000,
    });
  } catch (err: any) {
    console.log(
      `[tunnel] NOT hosting: "devtunnel show ${tid}" failed (${firstLine(err)}); ` +
        `not starting a host to avoid a duplicate. Re-run \`nanoclaw start\` or \`devtunnel host ${tid} --allow-anonymous\`.`,
    );
    return;
  }
  const hostCount = showOut.match(/Host connections\s*:\s*(\d+)/);
  if (hostCount && hostCount[1] !== '0') {
    console.log(`DevTunnel already hosting: ${tid} (connections: ${hostCount[1]})`);
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
  } catch (err: any) {
    console.log(`[tunnel] warning: could not write devtunnel.pid (${firstLine(err)})`);
  }
  console.log(`DevTunnel started (pid: ${dtProc.pid})`);
}

/**
 * Kill the devtunnel we started, if we tracked its pid. Idempotent.
 * Returns the pid we acted on for logging, or null when nothing was tracked.
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
