/**
 * Regression test for the bounded typing pulse after interim final-output.
 *
 * Background (kenan repro 2026-04-27, Teams):
 *   The original re-arm in commit 18daa61 armed an unbounded keepalive
 *   interval (Teams 3s tick, Telegram 4s tick) on every final-output,
 *   including the LAST final of a turn. Between that last final and
 *   `turn-end` (which can be many seconds while the runner drains its
 *   idle window or silently exits), the typing indicator stayed on
 *   forever. User saw "always typing".
 *
 * Fix shape (verified by static grep so we don't need to spin up the
 * full agent runner stack):
 *   1. After-interim-final must go through `armTypingBounded`, not
 *      `traceSetTyping(..., true, ...)` directly.
 *   2. A bounded auto-clear timer must exist, keyed per chatJid, that
 *      fires `setTyping(false)` if no other event happens first.
 *   3. Any subsequent traceSetTyping call must cancel the pending
 *      auto-clear so the normal multi-step flow doesn't double-toggle.
 *   4. The TTL constant must exist and have a sane value (a few seconds,
 *      not zero, not minutes).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('dispatcher: bounded typing pulse after interim final-output', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  it('uses armTypingBounded (not raw traceSetTyping) for after-interim-final', () => {
    // The label must appear inside an armTypingBounded call, not a
    // traceSetTyping(..., true, 'after-interim-final').
    expect(src).toMatch(
      /armTypingBounded\([\s\S]{0,200}?'after-interim-final'/,
    );
    // And NOT through the unbounded traceSetTyping path:
    expect(src).not.toMatch(
      /traceSetTyping\([\s\S]{0,200}?true[\s\S]{0,200}?'after-interim-final'/,
    );
  });

  it('defines a bounded TTL constant with a reasonable value (1s..30s)', () => {
    const m = src.match(/INTERIM_TYPING_TTL_MS\s*=\s*(\d+)/);
    expect(m).not.toBeNull();
    const ms = parseInt(m![1], 10);
    expect(ms).toBeGreaterThanOrEqual(1000);
    expect(ms).toBeLessThanOrEqual(30000);
  });

  it('armTypingBounded installs an auto-clear timer that calls setTyping(false)', () => {
    // The helper body must contain a setTimeout that fires setTyping(false).
    const start = src.indexOf('async function armTypingBounded');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 1500);
    expect(body).toMatch(/setTimeout\(/);
    expect(body).toMatch(/setTyping\([\s\S]{0,80}false\)/);
    // Stores the timer keyed by chatJid so we can cancel it later.
    expect(body).toMatch(/boundedTypingTimers\.set\(/);
  });

  it('every traceSetTyping cancels any pending bounded auto-clear', () => {
    // Pin the cancel hook inside the trace helper so a follow-on event
    // (next thinking, next final, turn-end, finally-guard) defuses the
    // pulse before it fires.
    const start = src.indexOf('function traceSetTyping(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 1200);
    expect(body).toMatch(/cancelBoundedTypingClear\(chatJid\)/);
  });

  it('cancelBoundedTypingClear clears + deletes the timer', () => {
    const start = src.indexOf('function cancelBoundedTypingClear(');
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, start + 400);
    expect(body).toMatch(/clearTimeout\(/);
    expect(body).toMatch(/boundedTypingTimers\.delete\(/);
  });
});
