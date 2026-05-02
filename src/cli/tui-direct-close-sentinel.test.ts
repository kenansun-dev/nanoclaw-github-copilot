import { describe, it, expect } from 'vitest';

import {
  isFinalOutput,
  makeCloseSentinelState,
  shouldWriteCloseSentinel,
} from './tui-direct-close-sentinel.js';

describe('isFinalOutput', () => {
  it('partial chunks are not final', () => {
    expect(isFinalOutput({ partial: true, status: 'success', result: 'x' }))
      .toBe(false);
  });

  it('"thinking" status with no result is not final (still-working pulse)', () => {
    expect(isFinalOutput({ status: 'thinking', result: null })).toBe(false);
    expect(isFinalOutput({ status: 'thinking' })).toBe(false);
    expect(isFinalOutput({ status: 'thinking', result: undefined })).toBe(
      false,
    );
  });

  it('"thinking" status WITH a result is final (terminal payload)', () => {
    expect(isFinalOutput({ status: 'thinking', result: 'PONG' })).toBe(true);
  });

  it('success / error are final', () => {
    expect(isFinalOutput({ status: 'success', result: 'PONG' })).toBe(true);
    expect(isFinalOutput({ status: 'success', result: null })).toBe(true);
    expect(isFinalOutput({ status: 'error', result: null })).toBe(true);
  });

  it('custom status with non-empty result is final', () => {
    expect(isFinalOutput({ status: 'partial-stream-done', result: 'P' })).toBe(
      true,
    );
  });

  it('custom status with empty result is NOT final', () => {
    expect(isFinalOutput({ status: 'whatever', result: null })).toBe(false);
    expect(isFinalOutput({ status: 'whatever' })).toBe(false);
  });

  it('partial:true wins even if status looks final', () => {
    expect(isFinalOutput({ partial: true, status: 'success', result: 'x' }))
      .toBe(false);
    expect(isFinalOutput({ partial: true, status: 'error' })).toBe(false);
  });
});

describe('shouldWriteCloseSentinel — once-only gate', () => {
  it('returns true exactly once for the first final output', () => {
    const s = makeCloseSentinelState();
    expect(shouldWriteCloseSentinel(s, { status: 'success', result: 'PONG' }))
      .toBe(true);
    // Second final output: must NOT trigger another close
    expect(shouldWriteCloseSentinel(s, { status: 'success', result: 'PONG2' }))
      .toBe(false);
  });

  it('returns false for partial / thinking outputs preceding the final', () => {
    const s = makeCloseSentinelState();
    expect(shouldWriteCloseSentinel(s, { status: 'thinking' })).toBe(false);
    expect(shouldWriteCloseSentinel(s, { partial: true, status: 'success' }))
      .toBe(false);
    expect(shouldWriteCloseSentinel(s, { status: 'thinking', result: null }))
      .toBe(false);
    // …and then the first FINAL fires the close
    expect(shouldWriteCloseSentinel(s, { status: 'success', result: 'PONG' }))
      .toBe(true);
    // …and a subsequent final still does not
    expect(shouldWriteCloseSentinel(s, { status: 'success', result: 'X' }))
      .toBe(false);
  });

  it('error status is treated as final and triggers close exactly once', () => {
    const s = makeCloseSentinelState();
    expect(shouldWriteCloseSentinel(s, { status: 'error' })).toBe(true);
    expect(shouldWriteCloseSentinel(s, { status: 'success', result: 'X' }))
      .toBe(false);
  });

  it('independent state objects have independent close-once semantics', () => {
    const s1 = makeCloseSentinelState();
    const s2 = makeCloseSentinelState();
    expect(shouldWriteCloseSentinel(s1, { status: 'success', result: 'a' }))
      .toBe(true);
    // s2 has not seen anything yet — must still fire once
    expect(shouldWriteCloseSentinel(s2, { status: 'success', result: 'b' }))
      .toBe(true);
    // But s1 is now consumed
    expect(shouldWriteCloseSentinel(s1, { status: 'success', result: 'c' }))
      .toBe(false);
  });

  it('all-partial sequence never triggers (regression guard for v2 stream)', () => {
    const s = makeCloseSentinelState();
    for (let i = 0; i < 20; i++) {
      expect(
        shouldWriteCloseSentinel(s, {
          partial: true,
          status: 'success',
          result: `chunk-${i}`,
        }),
      ).toBe(false);
    }
    expect(s.closeWritten).toBe(false);
  });
});
