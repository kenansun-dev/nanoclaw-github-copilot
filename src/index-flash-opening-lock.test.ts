import { describe, it, expect, vi } from 'vitest';
import { createOpeningLock } from './index.js';

/**
 * Bug 1 (kenan TG repro 2026-04-25 18:05):
 *   In flash mode, SDK fires reasoning_delta events at high rate. The
 *   first delta enters `if (!thinkingMsgId)` and awaits sendMessage;
 *   while pending, a second delta also sees thinkingMsgId === undefined
 *   and ALSO calls sendMessage → two orphan opening bubbles on screen.
 *
 * Fix: createOpeningLock() serializes the FIRST send across concurrent
 *   callers. Only one sendMessage runs; siblings await the same promise.
 */
describe('createOpeningLock (flash opening race)', () => {
  it('runs send() only once when called concurrently', async () => {
    const lock = createOpeningLock();
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    await Promise.all([lock.openOnce(send), lock.openOnce(send), lock.openOnce(send), lock.openOnce(send)]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('all callers resolve when the single send resolves', async () => {
    const lock = createOpeningLock();
    let done = false;
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      done = true;
    });
    const results = await Promise.all([lock.openOnce(send).then(() => done), lock.openOnce(send).then(() => done)]);
    expect(results).toEqual([true, true]);
  });

  it('inFlight() reflects pending state', async () => {
    const lock = createOpeningLock();
    expect(lock.inFlight()).toBe(false);
    let resolveSend: () => void = () => {};
    const sendPromise = new Promise<void>((r) => {
      resolveSend = r;
    });
    const p = lock.openOnce(async () => {
      await sendPromise;
    });
    expect(lock.inFlight()).toBe(true);
    resolveSend();
    await p;
    expect(lock.inFlight()).toBe(false);
  });

  it('after settle, next call runs a fresh send', async () => {
    const lock = createOpeningLock();
    const send1 = vi.fn(async () => {});
    const send2 = vi.fn(async () => {});
    await lock.openOnce(send1);
    await lock.openOnce(send2);
    expect(send1).toHaveBeenCalledTimes(1);
    expect(send2).toHaveBeenCalledTimes(1);
  });

  it('reset() drops the slot mid-flight (turn boundary)', async () => {
    const lock = createOpeningLock();
    let resolveSend: () => void = () => {};
    const send1 = vi.fn(async () => {
      await new Promise<void>((r) => {
        resolveSend = r;
      });
    });
    const p1 = lock.openOnce(send1);
    expect(lock.inFlight()).toBe(true);
    lock.reset();
    expect(lock.inFlight()).toBe(false);
    // After reset, a new openOnce kicks off a fresh send even if old one still pending.
    const send2 = vi.fn(async () => {});
    await lock.openOnce(send2);
    expect(send2).toHaveBeenCalledTimes(1);
    resolveSend();
    await p1;
  });

  it('failed send releases the slot so retries work', async () => {
    const lock = createOpeningLock();
    const send1 = vi.fn(async () => {
      throw new Error('boom');
    });
    await expect(lock.openOnce(send1)).rejects.toThrow('boom');
    expect(lock.inFlight()).toBe(false);
    const send2 = vi.fn(async () => {});
    await lock.openOnce(send2);
    expect(send2).toHaveBeenCalledTimes(1);
  });

  it('concurrent failed send: all waiters reject with the same error', async () => {
    const lock = createOpeningLock();
    const send = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 5));
      throw new Error('boom');
    });
    const results = await Promise.allSettled([lock.openOnce(send), lock.openOnce(send), lock.openOnce(send)]);
    expect(send).toHaveBeenCalledTimes(1);
    for (const r of results) {
      expect(r.status).toBe('rejected');
      if (r.status === 'rejected') {
        expect((r.reason as Error).message).toBe('boom');
      }
    }
  });
});
