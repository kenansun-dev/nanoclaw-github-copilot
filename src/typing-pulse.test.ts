/**
 * Real behavioral tests for the bounded typing pulse extracted from
 * src/index.ts → src/typing-pulse.ts.
 *
 * Replaces (alongside) the static-grep assertions in
 * src/dispatcher-typing-{bounded,rearm}.test.ts which only pin source
 * code string literals (e.g. 'after-interim-final'). Renaming a label
 * would break those tests but never break the behavior; this suite
 * drives the real timer state machine against a fake channel.
 *
 * Why we keep this separate from the index.ts grep tests: the grep tests
 * still serve as a "naming convention" guard for the dispatcher branch
 * (final-output → re-arm → turn-end), and rewriting them needs the full
 * dispatcher to be invokable without the agent-runner stack. That is a
 * larger refactor — captured in the audit doc.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTypingPulseState,
  armTypingBounded,
  cancelBoundedTypingClear,
  hasPendingTypingClear,
  type TypingChannel,
} from './typing-pulse.js';

function makeChannel(name = 'fake') {
  const setTyping = vi.fn(async (_jid: string, _isTyping: boolean) => {});
  const channel: TypingChannel & { setTyping: typeof setTyping } = {
    name,
    setTyping,
  };
  return channel;
}

describe('typing-pulse: bounded re-arm state machine', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('arm turns typing ON synchronously, schedules auto-clear after ttl', async () => {
    const state = createTypingPulseState();
    const ch = makeChannel();
    await armTypingBounded(state, ch, 'jid-1', 50);

    // ON delivered.
    expect(ch.setTyping).toHaveBeenNthCalledWith(1, 'jid-1', true);
    expect(hasPendingTypingClear(state, 'jid-1')).toBe(true);

    // Before ttl: no auto-clear.
    await vi.advanceTimersByTimeAsync(49);
    expect(ch.setTyping).toHaveBeenCalledTimes(1);

    // After ttl: auto-clear fires OFF and removes the timer entry.
    await vi.advanceTimersByTimeAsync(2);
    expect(ch.setTyping).toHaveBeenNthCalledWith(2, 'jid-1', false);
    expect(hasPendingTypingClear(state, 'jid-1')).toBe(false);
  });

  it('cancelBoundedTypingClear defuses pending auto-clear (no spurious OFF)', async () => {
    const state = createTypingPulseState();
    const ch = makeChannel();
    await armTypingBounded(state, ch, 'jid-1', 50);
    expect(hasPendingTypingClear(state, 'jid-1')).toBe(true);

    cancelBoundedTypingClear(state, 'jid-1');
    expect(hasPendingTypingClear(state, 'jid-1')).toBe(false);

    await vi.advanceTimersByTimeAsync(100);
    // Only the original ON; the OFF auto-clear must NOT have fired.
    expect(ch.setTyping).toHaveBeenCalledTimes(1);
    expect(ch.setTyping).toHaveBeenCalledWith('jid-1', true);
  });

  it('cancel is a no-op for an unknown jid (no throw, no calls)', () => {
    const state = createTypingPulseState();
    expect(() => cancelBoundedTypingClear(state, 'never-armed')).not.toThrow();
  });

  it('re-arming the same jid replaces the existing timer (latest ttl wins)', async () => {
    const state = createTypingPulseState();
    const ch = makeChannel();
    await armTypingBounded(state, ch, 'jid-1', 100);
    await vi.advanceTimersByTimeAsync(50);

    // Re-arm with shorter ttl. The original timer must be cancelled,
    // not coexist; otherwise we'd see a double OFF.
    await armTypingBounded(state, ch, 'jid-1', 30);

    // Advance past BOTH ttls (original would fire at t=100, new at t=80
    // from the perspective of test wall-clock t=50+30=80). If the old
    // timer was not cancelled, we'd see 2 OFFs by t=110.
    await vi.advanceTimersByTimeAsync(70);
    // ON × 2 (each arm) + OFF × 1 (only the second timer fires).
    expect(ch.setTyping).toHaveBeenCalledTimes(3);
    expect(ch.setTyping.mock.calls.filter((c) => c[1] === false)).toHaveLength(
      1,
    );
  });

  it('isolates timers per chatJid (cancelling one does not defuse another)', async () => {
    const state = createTypingPulseState();
    const ch = makeChannel();
    await armTypingBounded(state, ch, 'jid-A', 50);
    await armTypingBounded(state, ch, 'jid-B', 50);

    cancelBoundedTypingClear(state, 'jid-A');
    expect(hasPendingTypingClear(state, 'jid-A')).toBe(false);
    expect(hasPendingTypingClear(state, 'jid-B')).toBe(true);

    await vi.advanceTimersByTimeAsync(60);
    const offCalls = ch.setTyping.mock.calls.filter((c) => c[1] === false);
    expect(offCalls).toEqual([['jid-B', false]]);
  });

  it('skips channel.setTyping entirely when the channel does not support it', async () => {
    const state = createTypingPulseState();
    const channel: TypingChannel = { name: 'no-typing-channel' };
    await armTypingBounded(state, channel, 'jid-1', 20);
    expect(hasPendingTypingClear(state, 'jid-1')).toBe(true);
    await vi.advanceTimersByTimeAsync(30);
    // No throw, timer cleaned up.
    expect(hasPendingTypingClear(state, 'jid-1')).toBe(false);
  });

  it('logs a warning if the underlying setTyping throws on arm (does not throw)', async () => {
    const warn = vi.fn();
    const state = createTypingPulseState({ warn });
    const ch: TypingChannel = {
      name: 'flaky',
      setTyping: vi.fn(async () => {
        throw new Error('flaky-on');
      }),
    };
    await expect(armTypingBounded(state, ch, 'jid-1', 30)).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'jid-1', err: 'flaky-on' }),
      expect.stringMatching(/bounded typing arm failed/),
    );
  });

  it('logs a warning if the auto-clear setTyping(false) rejects', async () => {
    const warn = vi.fn();
    const state = createTypingPulseState({ warn });
    let calls = 0;
    const ch: TypingChannel = {
      name: 'flaky-off',
      setTyping: vi.fn(async (_jid, isTyping) => {
        calls++;
        if (!isTyping) throw new Error('flaky-off');
      }),
    };
    await armTypingBounded(state, ch, 'jid-1', 20);
    await vi.advanceTimersByTimeAsync(25);
    // Let the rejected promise's .catch run.
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ chatJid: 'jid-1', err: 'flaky-off' }),
      expect.stringMatching(/bounded typing auto-clear failed/),
    );
  });
});
