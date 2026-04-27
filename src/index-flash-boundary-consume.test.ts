import { describe, it, expect, vi } from 'vitest';
import { createOpeningLock } from './index.js';

/**
 * Bug 3 (kenan TG repro 2026-04-25 21:55, log-confirmed):
 *   In flash mode, after a SDK sentinel sets `queryBoundaryPending=true`,
 *   every subsequent reasoning_delta event entered the boundary reset
 *   block, wiping `thinkingMsgId` (and resetting the opening lock) on
 *   every frame. Result: 7 reasoning_delta frames → 7 sendMessage calls
 *   → 7 orphan "🧠 thinking…" bubbles in chat.
 *
 *   Root cause: `queryBoundaryPending = false` was only cleared in the
 *   `if (result.result)` branch (the answer path). Reasoning_delta events
 *   are `result.thinking && !result.result` and never reached that
 *   clearing line.
 *
 *   Fix: consume the sentinel inside the thinking-branch boundary block
 *   so it runs once per user query, not once per reasoning_delta frame.
 *
 * This test simulates the dispatcher state machine's relevant slice
 * (boundary flag + opening lock + thinkingMsgId) and verifies that the
 * fixed consumption logic produces exactly one sendMessage for a sentinel
 * followed by N reasoning_delta frames.
 */
describe('flash boundary sentinel consumption (bug 3)', () => {
  // Mirror of the dispatcher's per-chat state for the slice we care about.
  function makeState() {
    let queryBoundaryPendingThinking = false;
    let queryBoundaryPendingResult = false;
    let thinkingMsgId: string | undefined;
    let progressiveMsgId: string | undefined;
    let lastUserTurnSeqSeen = 0;
    let userTurnSeq = 0;
    let turnFinalized = false;
    const lock = createOpeningLock();
    const sendMessage = vi.fn(async () => {
      // Simulate TG send latency.
      await new Promise((r) => setTimeout(r, 1));
      return 'msg-' + Math.random().toString(36).slice(2, 8);
    });

    function pipeUserMessage(): void {
      // Mirrors GroupQueue: every user message (initial or piped follow-up)
      // increments userTurnSeq.
      userTurnSeq += 1;
    }

    async function onResult(result: {
      result?: string | null;
      partial?: boolean;
      thinking?: string;
      newSessionId?: string;
    }): Promise<void> {
      // Sentinel handling (mirrors src/index.ts ~L483).
      if (result.result === null && result.newSessionId && !result.partial) {
        queryBoundaryPendingThinking = true;
        queryBoundaryPendingResult = true;
      }

      // Reasoning_delta path (mirrors thinking branch ~L501).
      if (result.thinking && !result.result) {
        // Bug 6 gate: drop trailing reasoning_delta after turn finalize
        // (kenan TG repro 2026-04-26 00:03).
        if (turnFinalized && userTurnSeq === lastUserTurnSeqSeen) {
          return;
        }
        // Bug 5 turn-seq boundary (kenan TG repro 2026-04-25 22:54).
        if (userTurnSeq !== lastUserTurnSeqSeen) {
          lastUserTurnSeqSeen = userTurnSeq;
          queryBoundaryPendingThinking = true;
          queryBoundaryPendingResult = true;
          turnFinalized = false;
        }
        if (queryBoundaryPendingThinking) {
          queryBoundaryPendingThinking = false;
          thinkingMsgId = undefined;
          lock.reset();
        }
        if (!thinkingMsgId) {
          await lock.openOnce(async () => {
            const id = await sendMessage();
            thinkingMsgId = id;
          });
        }
        return;
      }

      // Result path (mirrors result.result branch ~L583).
      if (typeof result.result === 'string') {
        // Bug 5 turn-seq boundary on the result side too.
        if (userTurnSeq !== lastUserTurnSeqSeen) {
          lastUserTurnSeqSeen = userTurnSeq;
          queryBoundaryPendingThinking = true;
          queryBoundaryPendingResult = true;
          turnFinalized = false;
        }
        if (queryBoundaryPendingResult) {
          queryBoundaryPendingResult = false;
          progressiveMsgId = undefined;
        }
        if (!progressiveMsgId) {
          progressiveMsgId =
            'progressive-' + Math.random().toString(36).slice(2, 6);
        }
        // Bug 6: mark turn finalized when non-partial result arrives.
        if (result.partial === false || result.partial === undefined) {
          turnFinalized = true;
        }
      }
    }

    return {
      onResult,
      pipeUserMessage,
      sendMessage,
      get thinkingMsgId() {
        return thinkingMsgId;
      },
      get progressiveMsgId() {
        return progressiveMsgId;
      },
      get pendingThinking() {
        return queryBoundaryPendingThinking;
      },
      get pendingResult() {
        return queryBoundaryPendingResult;
      },
      get turnFinalized() {
        return turnFinalized;
      },
    };
  }

  it('sentinel + 7 sequential reasoning_delta -> exactly 1 sendMessage', async () => {
    const s = makeState();
    await s.onResult({ result: null, newSessionId: 'sess-a', partial: false });
    expect(s.pendingThinking).toBe(true);

    for (let i = 0; i < 7; i++) {
      await s.onResult({ thinking: 'step ' + i });
    }

    expect(s.sendMessage).toHaveBeenCalledTimes(1); // <- the bug
    expect(s.pendingThinking).toBe(false); // sentinel consumed exactly once
    expect(s.thinkingMsgId).toBeDefined();
  });

  it('sentinel + concurrent reasoning_delta -> still 1 sendMessage', async () => {
    const s = makeState();
    await s.onResult({ result: null, newSessionId: 'sess-b', partial: false });
    await Promise.all([
      s.onResult({ thinking: 'a' }),
      s.onResult({ thinking: 'b' }),
      s.onResult({ thinking: 'c' }),
      s.onResult({ thinking: 'd' }),
    ]);
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('two user turns: each fires its own sentinel, each opens 1 bubble', async () => {
    const s = makeState();
    // Turn 1
    await s.onResult({ result: null, newSessionId: 'sess-1', partial: false });
    await s.onResult({ thinking: 't1-step1' });
    await s.onResult({ thinking: 't1-step2' });
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    // Turn 2 (new sentinel from SDK on next user query)
    await s.onResult({ result: null, newSessionId: 'sess-2', partial: false });
    await s.onResult({ thinking: 't2-step1' });
    await s.onResult({ thinking: 't2-step2' });
    expect(s.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('reasoning_delta WITHOUT a preceding sentinel does NOT reset', async () => {
    const s = makeState();
    // First delta opens the bubble.
    await s.onResult({ thinking: 'just thinking' });
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    // Subsequent deltas reuse the same msgId (no boundary, no reset).
    await s.onResult({ thinking: 'more' });
    await s.onResult({ thinking: 'even more' });
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('thinking-then-result on new turn still resets progressiveMsgId (kenan 22:41 repro)', async () => {
    const s = makeState();
    s.pipeUserMessage();
    // Turn 1: result only, no thinking.
    await s.onResult({ result: null, newSessionId: 'sess-1', partial: false });
    await s.onResult({ result: 'turn1 answer' });
    const firstProgressive = s.progressiveMsgId;
    expect(firstProgressive).toBeDefined();

    // Turn 2: sentinel, then thinking, then result. The thinking branch
    // must NOT consume the result-side sentinel, otherwise the new turn
    // would edit turn1's reply instead of opening a new one.
    s.pipeUserMessage();
    await s.onResult({ result: null, newSessionId: 'sess-2', partial: false });
    await s.onResult({ thinking: 'turn2 reasoning' });
    await s.onResult({ result: 'turn2 answer' });

    expect(s.progressiveMsgId).not.toBe(firstProgressive);
    expect(s.pendingResult).toBe(false);
  });

  it('piped follow-up WITHOUT sentinel still treats as new turn (kenan 22:54 repro, bug 5)', async () => {
    const s = makeState();
    // Turn 1: spawn (pipe) + sentinel + result.
    s.pipeUserMessage();
    await s.onResult({ result: null, newSessionId: 'sess-x', partial: false });
    await s.onResult({ result: 'turn1 answer' });
    const turn1Progressive = s.progressiveMsgId;

    // Turn 2: piped follow-up. SDK reuses sessionId so no sentinel fires.
    // Without userTurnSeq advance detection, queryBoundaryPendingResult
    // would stay false and turn 2's answer would edit turn 1's bubble.
    s.pipeUserMessage();
    await s.onResult({ result: 'turn2 answer' }); // NO sentinel before this!

    expect(s.progressiveMsgId).not.toBe(turn1Progressive);
  });

  it('trailing reasoning_delta after final answer is dropped (kenan 00:03 repro, bug 6)', async () => {
    const s = makeState();
    s.pipeUserMessage();
    await s.onResult({ result: null, newSessionId: 'sess-y', partial: false });
    await s.onResult({ thinking: 'reasoning' });
    expect(s.sendMessage).toHaveBeenCalledTimes(1);
    // Final answer (non-partial) finalizes the turn.
    await s.onResult({ result: 'final answer', partial: false });
    expect(s.turnFinalized).toBe(true);

    // SDK fires trailing reasoning_delta AFTER finalize. Must be dropped:
    // no new sendMessage, no orphan thinking bubble.
    await s.onResult({ thinking: 'trailing tail 1' });
    await s.onResult({ thinking: 'trailing tail 2' });
    expect(s.sendMessage).toHaveBeenCalledTimes(1); // <- the bug

    // Next user turn (pipe) should clear the gate and allow new thinking.
    s.pipeUserMessage();
    await s.onResult({ thinking: 'turn 3 reasoning' });
    expect(s.sendMessage).toHaveBeenCalledTimes(2);
    expect(s.turnFinalized).toBe(false);
  });
});
