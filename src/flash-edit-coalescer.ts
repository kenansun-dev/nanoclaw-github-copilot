/**
 * Per-message-id edit coalescer for streaming `flash` thinking previews.
 *
 * Why this exists:
 *  - SDK emits reasoning_delta events at high rate; awaiting editMessage
 *    serially would block the dispatcher and pile up.
 *  - Naive parallel edits hit Telegram's 30/sec/chat rate limit.
 *  - editMessage on some channels silently falls back to sendMessage
 *    when the platform rejects an edit (markdown parse, rate limit,
 *    etc.) and returns a NEW message id. That's an orphan: the user
 *    already sees the previous preview; the new message is a duplicate.
 *    Earlier versions left those orphans on screen → N orphan thinking
 *    bubbles per turn (kenan TG repro 2026-04-25 00:35).
 *
 * What this does:
 *  1. At most one editMessage in flight per msgId at any time.
 *  2. Concurrent enqueues overwrite the pending text → natural coalesce.
 *  3. After each settled edit, if more text arrived, loop with the
 *     latest snapshot. Otherwise mark the worker done.
 *  4. If editMessage returns a NEW id (= silent sendMessage fallback),
 *     delete that orphan via deleteMessage (best effort) and call
 *     onOrphan(). Caller uses onOrphan to abandon the lane (set
 *     dismissed=true, clear thinkingMsgId) so subsequent deltas are no-ops.
 *  5. If editMessage throws, log and move on — never spawn a new
 *     sendMessage from inside the coalescer.
 *
 * Threading model: single-threaded JS event loop. The "lock" is the
 * `inFlight` promise field; absence of inFlight = nothing draining =
 * caller's enqueue is responsible for kicking off the worker.
 */

import type { Channel } from './types.js';
import { logger } from './log-extensions.js';

export type FlashEditOpts = { parseMode?: 'HTML' | 'Markdown' };

export interface FlashEditCoalescer {
  /**
   * Enqueue the latest desired text for `msgId`. If a worker is already
   * draining for this msgId, just overwrite pending state and return;
   * otherwise spin up a worker.
   */
  enqueue(msgId: string, text: string, opts: FlashEditOpts | undefined): void;
  /**
   * Wait for any in-flight edit on `msgId` to settle, then drop the
   * slot. Used before deleteMessage on the same msgId to avoid
   * edit-after-delete races.
   */
  drain(msgId: string): Promise<void>;
  /** Drop all slots; call on turn boundary. */
  clear(): void;
}

interface Slot {
  latest: string;
  opts: FlashEditOpts | undefined;
  inFlight: Promise<void> | null;
}

export function createFlashEditCoalescer(args: {
  channel: Pick<Channel, 'editMessage' | 'deleteMessage'>;
  chatJid: string;
  /**
   * Called when editMessage's silent sendMessage-fallback was detected
   * and the orphan was deleted (or attempted to be deleted). The caller
   * should abandon the thinking lane for the rest of this turn.
   */
  onOrphan: () => void;
}): FlashEditCoalescer {
  const { channel, chatJid, onOrphan } = args;
  const queue = new Map<string, Slot>();

  const drainSlot = async (msgId: string, slot: Slot): Promise<void> => {
    if (!channel.editMessage) return;
    while (true) {
      const snapshot = slot.latest;
      const snapshotOpts = slot.opts;
      try {
        const editedId = await channel.editMessage(
          chatJid,
          msgId,
          snapshot,
          snapshotOpts,
        );
        if (typeof editedId === 'string' && editedId !== msgId) {
          // Orphan: silent fallback to sendMessage spawned a new bubble.
          if (channel.deleteMessage) {
            try {
              await channel.deleteMessage(chatJid, editedId);
            } catch (delErr) {
              logger.warn(
                {
                  chatJid,
                  orphanId: editedId,
                  err: (delErr as Error).message,
                },
                'flash coalescer: failed to delete orphan from editMessage fallback (non-fatal)',
              );
            }
          }
          slot.inFlight = null;
          queue.delete(msgId);
          onOrphan();
          return;
        }
      } catch (err) {
        logger.warn(
          { chatJid, msgId, err: (err as Error).message },
          'flash coalescer: editMessage threw (non-fatal, will retry on next delta)',
        );
      }
      if (slot.latest === snapshot) {
        slot.inFlight = null;
        return;
      }
      // Loop with newer snapshot.
    }
  };

  return {
    enqueue(msgId, text, opts): void {
      if (!channel.editMessage) return;
      const existing = queue.get(msgId);
      if (existing) {
        existing.latest = text;
        existing.opts = opts;
        if (existing.inFlight) return;
        existing.inFlight = drainSlot(msgId, existing);
        return;
      }
      const slot: Slot = { latest: text, opts, inFlight: null };
      queue.set(msgId, slot);
      slot.inFlight = drainSlot(msgId, slot);
    },
    async drain(msgId): Promise<void> {
      const slot = queue.get(msgId);
      if (slot?.inFlight) {
        try {
          await slot.inFlight;
        } catch {
          /* worker swallows internally */
        }
      }
      queue.delete(msgId);
    },
    clear(): void {
      queue.clear();
    },
  };
}
