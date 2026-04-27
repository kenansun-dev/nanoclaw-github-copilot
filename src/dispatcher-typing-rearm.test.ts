/**
 * Pin the dispatcher behavior: after sending a "final-output" message
 * inside an agent turn, the dispatcher MUST re-arm the channel's typing
 * indicator (call setTyping(jid, true, 'after-interim-final')).
 *
 * Why: agent turns can produce multiple non-partial outputs (e.g. an
 * interim "我看看" followed by tool calls + a real answer). The previous
 * code path turned typing OFF on every final-output and never turned it
 * back ON until the next partial. Channels (Teams 3s keepalive, Telegram
 * 4s keepalive) lost their interval, so the user saw the typing indicator
 * disappear during the next thinking gap even though the agent was still
 * working. The turn-end / finally-guard branches idempotently clear it
 * once the turn really ends.
 *
 * This test inspects the source pattern instead of instantiating the full
 * dispatcher (which would require the entire agent runner stack).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('dispatcher: typing re-arm after interim final-output', () => {
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  it("calls traceSetTyping(..., true, 'after-interim-final') in the final-output branch", () => {
    expect(src).toMatch(/'after-interim-final'/);
  });

  it('the re-arm sits inside the non-partial / final-output branch (after turnFinalized = true)', () => {
    // Locate the final-output branch by its existing marker.
    const finalIdx = src.indexOf("'final-output'");
    expect(finalIdx).toBeGreaterThan(-1);
    const rearmIdx = src.indexOf("'after-interim-final'");
    expect(rearmIdx).toBeGreaterThan(finalIdx);
    // turnFinalized = true line must come before the re-arm
    const finalizedIdx = src.indexOf('turnFinalized = true', finalIdx);
    expect(finalizedIdx).toBeGreaterThan(-1);
    expect(rearmIdx).toBeGreaterThan(finalizedIdx);
  });

  it('still clears typing on turn-end and finally-guard (idempotent shutdown)', () => {
    expect(src).toMatch(/traceSetTyping\([\s\S]*?false[\s\S]*?'turn-end'/);
    expect(src).toMatch(/traceSetTyping\([\s\S]*?false[\s\S]*?'finally-guard'/);
  });

  it('only re-arms once per final-output (single occurrence in source)', () => {
    const matches = src.match(/'after-interim-final'/g) || [];
    expect(matches.length).toBe(1);
  });
});
