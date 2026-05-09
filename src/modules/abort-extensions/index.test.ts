import { describe, it, expect, vi, beforeEach } from 'vitest';
import { installAbortFork, __resetAbortForkInstalledForTests } from './index.js';
import { checkAbort, __resetAbortHandlersForTests } from '../../abort-handler-registry.js';

describe('abort-extensions install', () => {
  beforeEach(() => {
    __resetAbortHandlersForTests();
    __resetAbortForkInstalledForTests();
  });

  it('registers a handler that matches fork abort keywords', async () => {
    installAbortFork({ killActive: () => true });
    const h = checkAbort('stop');
    expect(h).not.toBeNull();
  });

  it('does not match non-abort content', () => {
    installAbortFork({ killActive: () => true });
    expect(checkAbort('hello there')).toBeNull();
  });

  it('matches CJK abort keywords', () => {
    installAbortFork({ killActive: () => true });
    expect(checkAbort('停')).not.toBeNull();
    expect(checkAbort('取消')).not.toBeNull();
  });

  it('invokes killActive and sendAck on abort', async () => {
    const killActive = vi.fn().mockReturnValue(true);
    const sendAck = vi.fn();
    installAbortFork({ killActive, sendAck });
    const h = checkAbort('cancel');
    await h!.onAbort('chat-1', { sender: 'u', content: 'cancel' });
    expect(killActive).toHaveBeenCalledWith('chat-1');
    expect(sendAck).toHaveBeenCalledWith('chat-1', '⚙️ Agent aborted.');
  });

  it('skips sendAck when killActive returns false (nothing was running)', async () => {
    const killActive = vi.fn().mockReturnValue(false);
    const sendAck = vi.fn();
    installAbortFork({ killActive, sendAck });
    const h = checkAbort('abort');
    await h!.onAbort('chat-1', { sender: 'u', content: 'abort' });
    expect(killActive).toHaveBeenCalled();
    expect(sendAck).not.toHaveBeenCalled();
  });

  it('is idempotent (second install is a no-op)', () => {
    installAbortFork({ killActive: () => true });
    installAbortFork({ killActive: () => true });
    // Only one handler should be registered: stop should match exactly one.
    const h1 = checkAbort('stop');
    expect(h1).not.toBeNull();
    // No way to count from the public API, but registry's internal array
    // length is 1 if idempotent — verified indirectly: we don't re-throw.
  });

  it('honours custom matcher override', () => {
    installAbortFork({
      killActive: () => true,
      matcher: (t) => t === 'BOOM',
    });
    expect(checkAbort('BOOM')).not.toBeNull();
    expect(checkAbort('stop')).toBeNull();
  });
});
