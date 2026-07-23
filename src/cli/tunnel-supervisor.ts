/**
 * tunnel-supervisor.ts — daemon-side health ring for the Teams devtunnel.
 *
 * WHY (2026-07-17→22 recurring incident): the `devtunnel host` process can
 * stay alive for days while its long-lived connection to the Azure relay is
 * dead — a home-router/NAT idle-timeout, a relay-side idle close, an expired
 * hosting token, or a one-second wifi hiccup drops the websocket but never
 * kills the process. Symptoms: outbound (ncl→Teams, direct Azure connector,
 * no tunnel) keeps working, inbound (Teams→relay→local :3978) silently dies,
 * and `ncl status` shows the tunnel green because it only probes the pid
 * (`process.kill(devtunnel.pid, 0)`, status-text.ts). Kenan sees "running"
 * yet gets zero inbound for days, and the only fix was a manual `ncl restart`
 * because `ensureTunnelHosting` is called exactly once at `ncl start`
 * (cli.ts) and nothing re-hosts afterwards.
 *
 * This module closes that gap:
 *   1. `evaluateTunnelHealth` — a PURE reducer over (probe result, prior
 *      state). No timers, no IO — unit-testable in isolation. Decides when a
 *      run of consecutive probe failures crosses the threshold and a rehost
 *      is due (respecting a cooldown so a slow rehost can't thrash).
 *   2. `startTunnelSupervisor` — the timer/IO shell. Every tick it probes the
 *      live connection (default: `devtunnel show <tid>` host-connection
 *      count), feeds the result to the reducer, rehosts when the reducer says
 *      so, and writes the latest verdict to `state/tunnel-health.json` so
 *      `ncl status` can report the real connection state instead of the pid.
 *
 * DESIGN NOTE — why probe the connection, not the pid: the whole bug is
 * "process alive, connection dead". A pid check is exactly the false-green
 * that hid this for days. `devtunnel show` reports the current host
 * connection count from the relay's point of view, which is the signal that
 * actually goes to zero when the relay drops the host.
 *
 * DESIGN NOTE — rehost = stop-then-ensure: `ensureTunnelHosting` alone would
 * see the still-alive `devtunnel host` process' 0-connection state and spawn
 * a SECOND host, orphaning the first and clobbering devtunnel.pid. So a
 * rehost first kills the tracked (stale) host via `stopTrackedTunnel`, then
 * calls `ensureTunnelHosting` to bring up a fresh one and rewrite the pid.
 *
 * LIVE-VERIFY CAVEAT: the default probe and the rehost path exercise the real
 * `devtunnel` CLI and Kenan's Windows host; they are covered by unit tests at
 * the reducer + injected-probe level, but the end-to-end "connection dropped
 * → auto-rehost restored inbound" loop must be confirmed on Kenan's machine
 * after deploy. Same honest boundary as PR #70.
 */

import fs from 'fs';
import { join } from 'path';
import { winExecSync } from '../win-process.js';

/** Persisted verdict `ncl status` reads so it can report the real state. */
export interface TunnelHealthSnapshot {
  /** Wall-clock ms of the last completed probe. */
  checkedAtMs: number;
  /** True when the most recent probe saw a live host connection. */
  connected: boolean;
  /** Consecutive failed probes ending at `checkedAtMs` (0 when connected). */
  consecutiveFailures: number;
  /** Wall-clock ms of the last rehost attempt, or null if none this run. */
  lastRehostAtMs: number | null;
  /** Tunnel id the supervisor is watching, for status display. */
  tunnelId: string | null;
}

/** Mutable state the reducer threads across ticks. */
export interface TunnelHealthState {
  consecutiveFailures: number;
  lastRehostAtMs: number | null;
}

export interface TunnelHealthConfig {
  /** Consecutive failed probes before a rehost is triggered. Default 3. */
  failureThreshold: number;
  /** Min ms between two rehost attempts. Default 60_000. */
  rehostCooldownMs: number;
}

export const DEFAULT_TUNNEL_HEALTH_CONFIG: TunnelHealthConfig = {
  failureThreshold: 3,
  rehostCooldownMs: 60_000,
};

export interface ProbeResult {
  /** True when the tunnel has at least one live host connection. */
  connected: boolean;
}

export interface TunnelHealthDecision {
  nextState: TunnelHealthState;
  /** True when the caller should perform a rehost now. */
  shouldRehost: boolean;
  /** Snapshot to persist for `ncl status`. */
  snapshot: TunnelHealthSnapshot;
}

/**
 * Pure reducer: given the current probe result and prior state, decide the
 * next state and whether a rehost is due. No timers, no IO — everything that
 * varies (now, tunnelId) is passed in so this is fully deterministic.
 *
 * Rehost fires when BOTH:
 *   - consecutive failures (including this probe) >= failureThreshold, AND
 *   - at least rehostCooldownMs has elapsed since the last rehost (or none yet)
 *
 * On a rehost decision we stamp `lastRehostAtMs = now` in the returned state
 * so the cooldown starts immediately and a slow-to-recover tunnel does not
 * trigger a rehost every single tick.
 */
export function evaluateTunnelHealth(
  probe: ProbeResult,
  prev: TunnelHealthState,
  cfg: TunnelHealthConfig,
  nowMs: number,
  tunnelId: string | null,
): TunnelHealthDecision {
  if (probe.connected) {
    const nextState: TunnelHealthState = {
      consecutiveFailures: 0,
      lastRehostAtMs: prev.lastRehostAtMs,
    };
    return {
      nextState,
      shouldRehost: false,
      snapshot: {
        checkedAtMs: nowMs,
        connected: true,
        consecutiveFailures: 0,
        lastRehostAtMs: prev.lastRehostAtMs,
        tunnelId,
      },
    };
  }

  const consecutiveFailures = prev.consecutiveFailures + 1;
  const thresholdCrossed = consecutiveFailures >= cfg.failureThreshold;
  const cooldownOk = prev.lastRehostAtMs == null || nowMs - prev.lastRehostAtMs >= cfg.rehostCooldownMs;
  const shouldRehost = thresholdCrossed && cooldownOk;

  const nextState: TunnelHealthState = {
    consecutiveFailures,
    lastRehostAtMs: shouldRehost ? nowMs : prev.lastRehostAtMs,
  };
  return {
    nextState,
    shouldRehost,
    snapshot: {
      checkedAtMs: nowMs,
      connected: false,
      consecutiveFailures,
      lastRehostAtMs: nextState.lastRehostAtMs,
      tunnelId,
    },
  };
}

const HEALTH_FILE_REL = join('state', 'tunnel-health.json');

/** Absolute path of the persisted health snapshot for a given workspace. */
export function tunnelHealthPath(ws: string): string {
  return join(ws, HEALTH_FILE_REL);
}

/** Write the snapshot atomically-ish; never throws (status is a diagnostic). */
export function writeTunnelHealth(ws: string, snap: TunnelHealthSnapshot): void {
  try {
    const p = tunnelHealthPath(ws);
    fs.mkdirSync(join(ws, 'state'), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(snap), 'utf-8');
  } catch {
    /* best-effort: status falls back to the pid probe */
  }
}

/** Read the persisted snapshot, or null when absent/unreadable. */
export function readTunnelHealth(ws: string): TunnelHealthSnapshot | null {
  try {
    const raw = fs.readFileSync(tunnelHealthPath(ws), 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.connected === 'boolean' && typeof parsed.checkedAtMs === 'number') {
      return parsed as TunnelHealthSnapshot;
    }
  } catch {
    /* absent or malformed → caller degrades */
  }
  return null;
}

/**
 * Default live probe: ask `devtunnel show <tid>` and read the host-connection
 * count. Connected ⇔ count > 0. Any error (CLI missing, timeout, tunnel gone)
 * is treated as not-connected so the reducer can escalate to a rehost.
 *
 * Reuses the exact `/Host connections\s*:\s*(\d+)/i` shape verified against
 * devtunnel CLI 1.0.1516 in PR #70 (sentence-case on Linux, title-case column
 * on Windows; `/i` covers both).
 *
 * Runs via `winExecSync` (execFile + `windowsHide:true`, no `cmd.exe`) rather
 * than string-form `execSync`. On Windows the string form always routes
 * through `cmd.exe /d /s /c` with `windowsHide:false`, and since this probe
 * fires every ~60s from the daemon it would flash a console window every
 * minute (kenan, 2026-07-23). execFile bypasses the shell entirely — no window
 * to flash — and is a no-op difference on POSIX.
 */
export function defaultTunnelProbe(tunnelId: string): ProbeResult {
  try {
    const out = winExecSync('devtunnel', ['show', tunnelId], { timeout: 15000 });
    const m = out.match(/Host connections\s*:\s*(\d+)/i);
    return { connected: !!m && m[1] !== '0' };
  } catch {
    return { connected: false };
  }
}

export interface TunnelSupervisorOptions {
  /** Workspace dir (for devtunnel.pid + state/tunnel-health.json). */
  ws: string;
  /** Tunnel id to watch. When null the supervisor no-ops (nothing to probe). */
  tunnelId: string | null;
  /** Probe interval in ms. Default 60_000. */
  intervalMs?: number;
  config?: Partial<TunnelHealthConfig>;
  /** Injectable for tests; defaults to the real devtunnel CLI probe. */
  probe?: (tunnelId: string) => ProbeResult;
  /** Injectable for tests; defaults to stop-tracked + ensureTunnelHosting. */
  rehost?: () => Promise<void>;
  /** Injectable clock for tests. Default Date.now. */
  now?: () => number;
  logger?: { info: (o: any, m: string) => void; warn: (o: any, m: string) => void };
}

export interface TunnelSupervisorHandle {
  /** Run one probe/evaluate/rehost/persist cycle. Exposed for tests. */
  tick: () => Promise<void>;
  /** Stop the interval. */
  stop: () => void;
}

/**
 * Default rehost: kill the tracked (stale) host, then bring up a fresh one.
 * Kept as a named export so the daemon and tests share one definition.
 */
export async function defaultRehost(ws: string): Promise<void> {
  const { stopTrackedTunnel, ensureTunnelHosting } = await import('./tunnel-lifecycle.js');
  stopTrackedTunnel(ws, (pid) => {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      /* already dead */
    }
  });
  await ensureTunnelHosting(ws);
}

/**
 * Start the health ring. Returns a handle with a manual `tick()` (used by
 * tests) and `stop()`. The interval is `.unref()`d so it never keeps the
 * process alive on its own. Safe to call with `tunnelId: null` (no-op).
 */
export function startTunnelSupervisor(opts: TunnelSupervisorOptions): TunnelSupervisorHandle {
  const cfg: TunnelHealthConfig = { ...DEFAULT_TUNNEL_HEALTH_CONFIG, ...(opts.config || {}) };
  const intervalMs = opts.intervalMs ?? 60_000;
  const probe = opts.probe ?? defaultTunnelProbe;
  const rehost = opts.rehost ?? (() => defaultRehost(opts.ws));
  const now = opts.now ?? Date.now;
  const log = opts.logger;

  let state: TunnelHealthState = { consecutiveFailures: 0, lastRehostAtMs: null };
  let running = false;

  async function tick(): Promise<void> {
    if (opts.tunnelId == null) return;
    if (running) return; // never overlap probes
    running = true;
    try {
      const result = probe(opts.tunnelId);
      const decision = evaluateTunnelHealth(result, state, cfg, now(), opts.tunnelId);
      state = decision.nextState;
      writeTunnelHealth(opts.ws, decision.snapshot);
      if (decision.shouldRehost) {
        log?.warn(
          { tunnelId: opts.tunnelId, consecutiveFailures: state.consecutiveFailures },
          'Tunnel health: connection down past threshold, rehosting',
        );
        try {
          await rehost();
          log?.info({ tunnelId: opts.tunnelId }, 'Tunnel health: rehost attempt completed');
        } catch (err: any) {
          log?.warn({ tunnelId: opts.tunnelId, err: err?.message || String(err) }, 'Tunnel health: rehost failed');
        }
      }
    } finally {
      running = false;
    }
  }

  const timer = setInterval(() => void tick(), intervalMs);
  if (typeof (timer as any).unref === 'function') (timer as any).unref();

  return {
    tick,
    stop: () => clearInterval(timer),
  };
}
