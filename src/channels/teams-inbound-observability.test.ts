import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/**
 * Regression test for the recurring "Teams goes silent, no errors in log"
 * incident (2026-07-17→20 and several prior). Root difficulty each time:
 * the INFO-level logs could not distinguish
 *
 *   (A) inbound never reached local :3978  (tunnel host connection down), vs
 *   (B) inbound reached the adapter but was silently rejected (e.g. JWT 401,
 *       which the Bot Framework adapter writes as a 4xx to the response
 *       WITHOUT throwing — so the surrounding catch never fires and no
 *       ERROR is logged).
 *
 * Operators had to `ncl loglevel debug` and reproduce live to tell A from B,
 * by which point a tunnel restart often erased the evidence.
 *
 * The fix logs, at INFO/WARN (visible without debug):
 *   - every POST that reaches /api/messages ("inbound reached local endpoint")
 *   - a WARN when the adapter returns >=400 without throwing
 *
 * Decision matrix at INFO after the fix:
 *   - no arrival line               => transport/tunnel down (cause A)
 *   - arrival line + >=400 WARN      => adapter rejected, likely auth (cause B)
 *   - arrival line + no activity line => still dropped in adapter (cause B)
 *
 * We pin the source pattern (same approach as teams-listen-retry.test.ts /
 * teams-capability.test.ts) so a future refactor can't silently demote these
 * back to debug and reintroduce the "have to enable debug to diagnose" trap.
 */
describe('Teams inbound observability', () => {
  const src = fs.readFileSync(new URL('./teams.ts', import.meta.url), 'utf-8');

  it('logs inbound POST arrival at INFO (not debug)', () => {
    // Must be logger.info, not logger.debug — the whole point is that this is
    // visible without `ncl loglevel debug`.
    expect(src).toMatch(/logger\.info\([^;]*inbound reached local endpoint/s);
  });

  it('does NOT gate the arrival marker behind logger.debug', () => {
    // The old line was `logger.debug(... 'Teams webhook received')`. Guard
    // against a regression that reintroduces a debug-only arrival marker as
    // the only arrival signal.
    expect(src).not.toMatch(/logger\.debug\([^;]*Teams webhook received['"]/);
  });

  it('warns when the adapter returns >=400 without throwing (silent auth reject)', () => {
    expect(src).toMatch(/res\.statusCode\s*>=\s*400/);
    expect(src).toMatch(/logger\.warn\([^;]*inbound dropped/s);
  });
});
