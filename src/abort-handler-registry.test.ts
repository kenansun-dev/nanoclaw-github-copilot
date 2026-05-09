/**
 * Tests for the abort-handler registry skeleton (B.5-prep #4).
 *
 * Covers the matcher-walk contract:
 * - empty registry returns null
 * - first matching handler wins, later matchers not consulted
 * - registration order is preserved
 * - non-matching handlers don't run their onAbort
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerAbortHandler,
  checkAbort,
  getAbortHandlers,
  __resetAbortHandlersForTests,
  type AbortHandler,
} from './abort-handler-registry.js';

const noopOnAbort = async () => {};

describe('abort-handler-registry', () => {
  beforeEach(() => {
    __resetAbortHandlersForTests();
  });

  it('returns null when no handlers are registered', () => {
    expect(checkAbort('please stop')).toBeNull();
    expect(getAbortHandlers()).toHaveLength(0);
  });

  it('returns null when no matcher matches', () => {
    registerAbortHandler({ matcher: () => false, onAbort: noopOnAbort });
    expect(checkAbort('hello')).toBeNull();
  });

  it('returns first matching handler and stops walking', () => {
    const calls: string[] = [];
    const a: AbortHandler = {
      matcher: (t) => {
        calls.push('a');
        return false;
      },
      onAbort: noopOnAbort,
    };
    const b: AbortHandler = {
      matcher: (t) => {
        calls.push('b');
        return t === 'stop';
      },
      onAbort: noopOnAbort,
    };
    const c: AbortHandler = {
      matcher: (t) => {
        calls.push('c');
        return true;
      },
      onAbort: noopOnAbort,
    };
    registerAbortHandler(a);
    registerAbortHandler(b);
    registerAbortHandler(c);

    expect(checkAbort('stop')).toBe(b);
    expect(calls).toEqual(['a', 'b']); // c never consulted
  });

  it('does not call onAbort during checkAbort (matcher only)', async () => {
    const onAbort = vi.fn(async () => {});
    registerAbortHandler({ matcher: () => true, onAbort });
    const h = checkAbort('cancel');
    expect(h).not.toBeNull();
    expect(onAbort).not.toHaveBeenCalled();
    // Caller-side invocation is what runs onAbort.
    await h!.onAbort('jid@x', { sender: 'alice', content: 'cancel' });
    expect(onAbort).toHaveBeenCalledTimes(1);
  });

  it('preserves registration order in getAbortHandlers snapshot', () => {
    const a: AbortHandler = { matcher: () => false, onAbort: noopOnAbort };
    const b: AbortHandler = { matcher: () => false, onAbort: noopOnAbort };
    registerAbortHandler(a);
    registerAbortHandler(b);
    expect(getAbortHandlers()).toEqual([a, b]);
  });
});
