import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import { join } from 'path';
import {
  evaluateTunnelHealth,
  startTunnelSupervisor,
  writeTunnelHealth,
  readTunnelHealth,
  tunnelHealthPath,
  DEFAULT_TUNNEL_HEALTH_CONFIG,
  type TunnelHealthState,
  type ProbeResult,
} from './tunnel-supervisor.js';

const CFG = DEFAULT_TUNNEL_HEALTH_CONFIG;
const FRESH: TunnelHealthState = { consecutiveFailures: 0, lastRehostAtMs: null };

describe('evaluateTunnelHealth (pure reducer)', () => {
  it('connected probe resets the failure run and never rehosts', () => {
    const prev: TunnelHealthState = { consecutiveFailures: 2, lastRehostAtMs: 5 };
    const d = evaluateTunnelHealth({ connected: true }, prev, CFG, 1000, 'tid');
    expect(d.shouldRehost).toBe(false);
    expect(d.nextState.consecutiveFailures).toBe(0);
    // cooldown clock (lastRehostAtMs) is preserved across a recovery
    expect(d.nextState.lastRehostAtMs).toBe(5);
    expect(d.snapshot).toMatchObject({ connected: true, consecutiveFailures: 0, tunnelId: 'tid', checkedAtMs: 1000 });
  });

  it('does not rehost before the failure threshold is crossed', () => {
    let s = FRESH;
    const d1 = evaluateTunnelHealth({ connected: false }, s, CFG, 10, 'tid');
    expect(d1.shouldRehost).toBe(false);
    expect(d1.nextState.consecutiveFailures).toBe(1);
    s = d1.nextState;
    const d2 = evaluateTunnelHealth({ connected: false }, s, CFG, 20, 'tid');
    expect(d2.shouldRehost).toBe(false);
    expect(d2.nextState.consecutiveFailures).toBe(2);
  });

  it('rehosts exactly when consecutive failures reach the threshold', () => {
    let s = FRESH;
    let last;
    for (let i = 1; i <= CFG.failureThreshold; i++) {
      last = evaluateTunnelHealth({ connected: false }, s, CFG, i * 10, 'tid');
      s = last.nextState;
    }
    expect(last!.shouldRehost).toBe(true);
    // rehost stamps the cooldown clock at the current time
    expect(last!.nextState.lastRehostAtMs).toBe(CFG.failureThreshold * 10);
    expect(last!.snapshot.connected).toBe(false);
  });

  it('respects the cooldown: no second rehost while still failing within the window', () => {
    // Prime state: already rehosted at t=1000, threshold-1 failures banked.
    const primed: TunnelHealthState = {
      consecutiveFailures: CFG.failureThreshold, // already past threshold
      lastRehostAtMs: 1000,
    };
    // Next failing probe only 5s later — cooldown (60s) not elapsed.
    const d = evaluateTunnelHealth({ connected: false }, primed, CFG, 6000, 'tid');
    expect(d.shouldRehost).toBe(false);
    // failures keep climbing, cooldown clock unchanged
    expect(d.nextState.consecutiveFailures).toBe(CFG.failureThreshold + 1);
    expect(d.nextState.lastRehostAtMs).toBe(1000);
  });

  it('rehosts again once the cooldown has elapsed', () => {
    const primed: TunnelHealthState = {
      consecutiveFailures: CFG.failureThreshold + 5,
      lastRehostAtMs: 1000,
    };
    const d = evaluateTunnelHealth({ connected: false }, primed, CFG, 1000 + CFG.rehostCooldownMs, 'tid');
    expect(d.shouldRehost).toBe(true);
    expect(d.nextState.lastRehostAtMs).toBe(1000 + CFG.rehostCooldownMs);
  });
});

describe('tunnel-health snapshot persistence', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(join(os.tmpdir(), 'ncl-tunhealth-'));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('round-trips a snapshot through write/read', () => {
    writeTunnelHealth(ws, {
      checkedAtMs: 42,
      connected: true,
      consecutiveFailures: 0,
      lastRehostAtMs: null,
      tunnelId: 'tid',
    });
    expect(fs.existsSync(tunnelHealthPath(ws))).toBe(true);
    const back = readTunnelHealth(ws);
    expect(back).toMatchObject({ checkedAtMs: 42, connected: true, tunnelId: 'tid' });
  });

  it('read returns null when the file is absent', () => {
    expect(readTunnelHealth(ws)).toBeNull();
  });

  it('read returns null (not throw) on malformed json', () => {
    fs.mkdirSync(join(ws, 'state'), { recursive: true });
    fs.writeFileSync(tunnelHealthPath(ws), '{ not json', 'utf-8');
    expect(readTunnelHealth(ws)).toBeNull();
  });
});

describe('startTunnelSupervisor (injected probe/rehost, no timers)', () => {
  let ws: string;
  beforeEach(() => {
    ws = fs.mkdtempSync(join(os.tmpdir(), 'ncl-tunsup-'));
  });
  afterEach(() => {
    fs.rmSync(ws, { recursive: true, force: true });
  });

  it('no-ops (no probe, no file) when tunnelId is null', async () => {
    const probe = vi.fn<[], ProbeResult>(() => ({ connected: true }));
    const h = startTunnelSupervisor({ ws, tunnelId: null, probe });
    await h.tick();
    h.stop();
    expect(probe).not.toHaveBeenCalled();
    expect(readTunnelHealth(ws)).toBeNull();
  });

  it('healthy probe writes a connected snapshot and never rehosts', async () => {
    const rehost = vi.fn(async () => {});
    const h = startTunnelSupervisor({
      ws,
      tunnelId: 'tid',
      probe: () => ({ connected: true }),
      rehost,
      now: () => 111,
    });
    await h.tick();
    h.stop();
    expect(rehost).not.toHaveBeenCalled();
    expect(readTunnelHealth(ws)).toMatchObject({ connected: true, checkedAtMs: 111, tunnelId: 'tid' });
  });

  it('triggers exactly one rehost after threshold consecutive failures', async () => {
    const rehost = vi.fn(async () => {});
    let t = 0;
    const h = startTunnelSupervisor({
      ws,
      tunnelId: 'tid',
      probe: () => ({ connected: false }),
      rehost,
      now: () => (t += 1000), // +1s per probe, far under the 60s cooldown
    });
    for (let i = 0; i < CFG.failureThreshold; i++) await h.tick();
    h.stop();
    expect(rehost).toHaveBeenCalledTimes(1);
    const snap = readTunnelHealth(ws);
    expect(snap?.connected).toBe(false);
    expect(snap?.consecutiveFailures).toBe(CFG.failureThreshold);
  });

  it('does not overlap: a slow rehost is not re-entered by a second tick', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const rehost = vi.fn(async () => {
      await gate;
    });
    let t = 0;
    const h = startTunnelSupervisor({
      ws,
      tunnelId: 'tid',
      config: { failureThreshold: 1 }, // rehost on the very first failure
      probe: () => ({ connected: false }),
      rehost,
      now: () => (t += 1000),
    });
    // First tick enters rehost and blocks on the gate.
    const first = h.tick();
    // Second tick fires while the first is still awaiting rehost — must no-op.
    await h.tick();
    expect(rehost).toHaveBeenCalledTimes(1);
    release();
    await first;
    h.stop();
    expect(rehost).toHaveBeenCalledTimes(1);
  });

  it('a rehost that throws is swallowed (supervisor keeps running)', async () => {
    const rehost = vi.fn(async () => {
      throw new Error('devtunnel host failed');
    });
    const warn = vi.fn();
    let t = 0;
    const h = startTunnelSupervisor({
      ws,
      tunnelId: 'tid',
      config: { failureThreshold: 1 },
      probe: () => ({ connected: false }),
      rehost,
      now: () => (t += 1000),
      logger: { info: vi.fn(), warn },
    });
    await expect(h.tick()).resolves.toBeUndefined();
    h.stop();
    expect(rehost).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalled();
  });
});
