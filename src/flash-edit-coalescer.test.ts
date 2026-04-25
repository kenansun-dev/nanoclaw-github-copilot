import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createFlashEditCoalescer } from './flash-edit-coalescer.js';

// Helper: tiny deterministic deferred promise.
function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('flash-edit-coalescer', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('serializes edits per msgId (one in-flight at a time)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const editMessage = vi.fn(async (_jid, msgId) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      return msgId;
    });
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage },
      chatJid: 'tg:1',
      onOrphan: () => {},
    });

    coalescer.enqueue('m1', 'a', undefined);
    coalescer.enqueue('m1', 'b', undefined);
    coalescer.enqueue('m1', 'c', undefined);
    coalescer.enqueue('m1', 'd', undefined);
    await coalescer.drain('m1');

    expect(maxInFlight).toBe(1);
  });

  it('coalesces: many enqueues during one in-flight edit collapse to one extra edit with latest text', async () => {
    const calls: string[] = [];
    const firstStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    let firstDone = false;
    const editMessage = vi.fn(async (_jid, msgId, text) => {
      calls.push(text);
      if (!firstDone) {
        firstDone = true;
        firstStarted.resolve();
        await releaseFirst.promise;
      }
      return msgId;
    });
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage },
      chatJid: 'tg:1',
      onOrphan: () => {},
    });

    coalescer.enqueue('m1', 'first', undefined);
    await firstStarted.promise; // worker is now blocked inside editMessage('first')
    coalescer.enqueue('m1', 'mid-1', undefined);
    coalescer.enqueue('m1', 'mid-2', undefined);
    coalescer.enqueue('m1', 'final', undefined);
    releaseFirst.resolve();
    await coalescer.drain('m1');

    // Exactly two edits: the original 'first' + one coalesced edit using the LAST snapshot.
    expect(calls).toEqual(['first', 'final']);
  });

  it('detects orphan when editMessage returns a NEW id, deletes orphan, fires onOrphan', async () => {
    const editMessage = vi.fn(async () => 'm1-orphan-from-fallback');
    const deleteMessage = vi.fn(async () => {});
    const onOrphan = vi.fn();
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage, deleteMessage },
      chatJid: 'tg:1',
      onOrphan,
    });

    coalescer.enqueue('m1', 'text', undefined);
    await coalescer.drain('m1');

    expect(deleteMessage).toHaveBeenCalledWith(
      'tg:1',
      'm1-orphan-from-fallback',
    );
    expect(onOrphan).toHaveBeenCalledTimes(1);
  });

  it('does not fire onOrphan when editMessage returns the same id', async () => {
    const editMessage = vi.fn(async (_jid, msgId) => msgId);
    const deleteMessage = vi.fn(async () => {});
    const onOrphan = vi.fn();
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage, deleteMessage },
      chatJid: 'tg:1',
      onOrphan,
    });

    coalescer.enqueue('m1', 'a', undefined);
    coalescer.enqueue('m1', 'b', undefined);
    await coalescer.drain('m1');

    expect(deleteMessage).not.toHaveBeenCalled();
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('does not fire onOrphan when editMessage returns void (no fallback signal)', async () => {
    const editMessage = vi.fn(async () => undefined);
    const onOrphan = vi.fn();
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage },
      chatJid: 'tg:1',
      onOrphan,
    });

    coalescer.enqueue('m1', 'a', undefined);
    await coalescer.drain('m1');

    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('does not throw or call sendMessage when editMessage rejects; allows next enqueue to retry', async () => {
    let attempts = 0;
    const editMessage = vi.fn(async (_jid, msgId) => {
      attempts++;
      if (attempts === 1) throw new Error('TG rate limit');
      return msgId;
    });
    const onOrphan = vi.fn();
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage },
      chatJid: 'tg:1',
      onOrphan,
    });

    coalescer.enqueue('m1', 'first', undefined);
    await coalescer.drain('m1');
    coalescer.enqueue('m1', 'second', undefined);
    await coalescer.drain('m1');

    expect(attempts).toBe(2);
    expect(onOrphan).not.toHaveBeenCalled();
  });

  it('orphan path swallows deleteMessage failures (best-effort cleanup)', async () => {
    const editMessage = vi.fn(async () => 'orphan');
    const deleteMessage = vi.fn(async () => {
      throw new Error('orphan already gone');
    });
    const onOrphan = vi.fn();
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage, deleteMessage },
      chatJid: 'tg:1',
      onOrphan,
    });

    await expect(
      (async () => {
        coalescer.enqueue('m1', 'x', undefined);
        await coalescer.drain('m1');
      })(),
    ).resolves.toBeUndefined();
    expect(onOrphan).toHaveBeenCalledTimes(1);
  });

  it('drain resolves immediately when nothing is queued', async () => {
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage: vi.fn() },
      chatJid: 'tg:1',
      onOrphan: () => {},
    });
    await expect(coalescer.drain('never-enqueued')).resolves.toBeUndefined();
  });

  it('clear() drops all slots; subsequent enqueue starts fresh worker', async () => {
    const editMessage = vi.fn(async (_jid, msgId) => msgId);
    const coalescer = createFlashEditCoalescer({
      channel: { editMessage },
      chatJid: 'tg:1',
      onOrphan: () => {},
    });
    coalescer.enqueue('m1', 'a', undefined);
    await coalescer.drain('m1');
    coalescer.clear();
    coalescer.enqueue('m1', 'b', undefined);
    await coalescer.drain('m1');
    expect(editMessage).toHaveBeenCalledTimes(2);
  });

  it('no-op when channel.editMessage is undefined', () => {
    const coalescer = createFlashEditCoalescer({
      channel: {},
      chatJid: 'tg:1',
      onOrphan: () => {},
    });
    expect(() => coalescer.enqueue('m1', 'a', undefined)).not.toThrow();
  });
});
