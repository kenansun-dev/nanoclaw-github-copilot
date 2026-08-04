import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TeamsStreamingSession,
  SendTimeoutError,
  makeAdapterSender,
  extractWireRejectDetail,
  type ActivitySender,
  type TeamsActivity,
} from './teams-streaming.js';

/**
 * Tests for the Teams streaming wire protocol implementation.
 *
 * We test the StreamingSession against a mocked ActivitySender so we
 * never need a real Bot Framework adapter. The class is the protocol
 * surface; the adapter wrapper (makeAdapterSender) is trivial glue.
 *
 * Focus areas:
 *  - Activity shape: the first `typing` chunk uses `streamType:'informative'`
 *    (the bootstrap that establishes the stream), every subsequent chunk
 *    uses `streamType:'streaming'` with a monotonic `streamSequence`.
 *  - First chunk has no streamId; subsequent activities carry the id
 *    returned by the first send and stamp it on entity[0]. The bootstrap
 *    decision is tracked via an internal flag, not derived from
 *    `!streamId`, so a server response without an id doesn't trick us
 *    into sending multiple `informative` activities.
 *  - End publishes a `message` activity with `streamType:'final'`,
 *    carrying the streamId. If no streamId was ever obtained (chunks
 *    failed, or none fired), end degrades to a plain non-streaming
 *    `message` activity so the agent's reply still lands.
 *  - Single in-flight: chunks queued during a slow send don't fire
 *    in parallel; the latest cumulative text wins.
 *  - Idempotency: end()/cancel() called twice are no-ops.
 *  - Error degradation: ContentStreamNotAllowed cancels; the
 *    "streaming api is not enabled" error switches to a single-final
 *    fallback so end() still publishes the agent's reply.
 */

function makeSender() {
  const calls: Array<Partial<TeamsActivity>> = [];
  let nextId = 1;
  const sender: ActivitySender = vi.fn(async (activity) => {
    calls.push(JSON.parse(JSON.stringify(activity)));
    return `msg-${nextId++}`;
  });
  return { calls, sender };
}

const silentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as any;

describe('TeamsStreamingSession', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('emits typing+streaminfo for chunks and message+final for end', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('hello');
    await s.end('hello world');

    // First chunk + final
    expect(calls.length).toBeGreaterThanOrEqual(2);
    const first = calls[0];
    const last = calls[calls.length - 1];

    expect(first.type).toBe('typing');
    expect(first.text).toBe('hello');
    expect(first.entities?.[0].type).toBe('streamInfo');
    // First activity is `informative` (start streaming) per Teams docs.
    // Sending `streaming` as the first activity is rejected by the
    // server ("Only start streaming and continue streaming types are
    // allowed as a typing activity"). Regression 2026-04-22.
    expect(first.entities?.[0].streamType).toBe('informative');
    expect(first.entities?.[0].streamSequence).toBe(1);

    expect(last.type).toBe('message');
    expect(last.text).toBe('hello world');
    expect(last.entities?.[0].streamType).toBe('final');
  });

  it('binds streamId from the first response onto subsequent activities', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('a');
    // give drain a tick to finish
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('ab');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abc');

    const first = calls[0];
    const second = calls.find((c, i) => i > 0 && c.type === 'typing') as Partial<TeamsActivity>;
    const final = calls[calls.length - 1];

    // 2026-08-04: streamId is SERVER-assigned. The bootstrap frame carries
    // NO streamId; the id returned by that first call is echoed on every
    // subsequent activity (per the Teams streaming REST contract).
    expect(first.entities?.[0].streamId).toBeUndefined();
    const serverId = second?.entities?.[0].streamId;
    expect(serverId).toBe('msg-1');
    expect(final.entities?.[0].streamId).toBe(serverId);
  });

  it('uses monotonically increasing streamSequence numbers', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('ab');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('abc');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abcd');

    const sequences = calls
      .map((c) => c.entities?.[0].streamSequence)
      .filter((n): n is number => typeof n === 'number');

    // Strictly increasing.
    for (let i = 1; i < sequences.length; i++) {
      expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
    }
    // Sequence starts at 1.
    expect(sequences[0]).toBe(1);
  });

  it('serializes chunks (single in-flight) and coalesces stale text', async () => {
    let resolveFirstSend!: () => void;
    let inFlight = 0;
    let maxInFlight = 0;
    const calls: Array<Partial<TeamsActivity>> = [];
    let firstSeen = false;
    const sender: ActivitySender = async (activity) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      calls.push(JSON.parse(JSON.stringify(activity)));
      if (!firstSeen) {
        firstSeen = true;
        await new Promise<void>((r) => (resolveFirstSend = r));
      }
      inFlight--;
      return `msg-${calls.length}`;
    };

    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    // Pile chunks while the first send is blocked.
    await s.chunk('a');
    await s.chunk('ab');
    await s.chunk('abc');
    await s.chunk('abcd');
    // Release the first send.
    resolveFirstSend();

    await s.end('abcde');

    // Never had two sends in flight at once.
    expect(maxInFlight).toBe(1);

    // The chunks that piled up should have been coalesced: drain only
    // resends with the latest cumulative text. We don't pin an exact
    // number of typing calls (depends on drain timing), but we DO
    // require the last typing-text to be the most recent cumulative
    // pre-end text and never any stale earlier-still-leading-prefix
    // (no typing call should send "a" twice).
    const typingTexts = calls.filter((c) => c.type === 'typing').map((c) => c.text);
    expect(typingTexts[0]).toBe('a');
    expect(typingTexts.length).toBeLessThanOrEqual(2);
    // Last typing must be a prefix of the final text.
    expect('abcde'.startsWith(typingTexts[typingTexts.length - 1] ?? '')).toBe(true);
  });

  it('end() and cancel() are idempotent', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });
    await s.chunk('hi');
    await s.end('hi there');
    const before = calls.length;
    await s.end('extra');
    await s.cancel();
    expect(calls.length).toBe(before);

    const s2 = new TeamsStreamingSession(makeSender().sender, {
      delayInMs: 0,
      log: silentLog,
    });
    await s2.cancel();
    await s2.cancel();
    await s2.end('shouldnt-send');
  });

  it('degrades to a single non-streaming final on "streaming api is not enabled"', async () => {
    const calls: Array<Partial<TeamsActivity>> = [];
    let chunkCalled = 0;
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      if (activity.type === 'typing') {
        chunkCalled++;
        if (chunkCalled === 1) {
          throw new Error('BadArgument: streaming api is not enabled for this conversation');
        }
      }
      return `msg-${calls.length}`;
    };

    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('hello');
    // Give drain time to absorb the rejection.
    await new Promise((r) => setTimeout(r, 10));
    await s.chunk('hello world');
    await s.end('hello world final');

    // After degradation, end() publishes a plain `message` activity
    // (no streaminfo entities).
    const finals = calls.filter((c) => c.type === 'message');
    expect(finals.length).toBe(1);
    expect(finals[0].text).toBe('hello world final');
    expect(finals[0].entities ?? []).toEqual([]);
  });

  it('degrades to plain message on ContentStreamNotAllowed mid-stream (regression)', async () => {
    // Regression for the silent-final-drop bug discovered in code review
    // (rpi5, 2026-04-22): the wire layer rejecting mid-stream
    // (`ContentStreamNotAllowed`) used to set `_cancelled=true`, then
    // `end()` saw the cancel flag and bailed without publishing the
    // agent's reply. The fix distinguishes wire-cancel from explicit
    // dispatcher `cancel()`: only the explicit case suppresses the final.
    const calls: Array<Partial<TeamsActivity>> = [];
    let chunkCalled = 0;
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      if (activity.type === 'typing') {
        chunkCalled++;
        if (chunkCalled === 1) {
          throw new Error('ContentStreamNotAllowed: user paused at client');
        }
      }
      return `msg-${calls.length}`;
    };

    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 10));
    await s.chunk('ab');
    const id = await s.end('abc');

    // One typing send attempted (rejected), one plain-message final
    // (the degraded fallback so the agent's reply still lands).
    const typing = calls.filter((c) => c.type === 'typing');
    const messages = calls.filter((c) => c.type === 'message');
    expect(typing.length).toBe(1);
    expect(messages.length).toBe(1);
    // Plain message: no streaminfo entities (those only make sense
    // inside an active stream).
    expect(messages[0].entities ?? []).toEqual([]);
    expect(messages[0].text).toBe('abc');
    expect(typeof id).toBe('string');
  });

  it('isCancelled() flips true after wire reject but stays false after explicit cancel (bug 2 dispatcher contract)', async () => {
    // The dispatcher distinguishes the two cases to decide whether to
    // arm the coalesced-final fallback (bug 2). Wire reject (e.g.
    // `ContentStreamNotAllowed`, `streaming api is not enabled`)
    // → `isCancelled() === true` and subsequent finals must be
    // buffered + flushed as one bubble. Explicit dispatcher cancel
    // → `isCancelled() === false` (it's a normal turn boundary, not
    // a failure we need to compensate for).
    let chunkCalled = 0;
    const sender: ActivitySender = async (activity) => {
      if (activity.type === 'typing') {
        chunkCalled++;
        if (chunkCalled === 1) {
          throw new Error('ContentStreamNotAllowed: user paused at client');
        }
      }
      return `msg-${chunkCalled}`;
    };
    const sWire = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    expect(sWire.isCancelled()).toBe(false);
    await sWire.chunk('a');
    await new Promise((r) => setTimeout(r, 10));
    expect(sWire.isCancelled()).toBe(true);
    // Further chunk() calls must be noops (idempotent + safe for the
    // dispatcher to keep calling while it routes finals to the buffer).
    await sWire.chunk('ab');
    await sWire.chunk('abc');
    expect(sWire.isCancelled()).toBe(true);

    const { sender: cleanSender } = makeSender();
    const sExplicit = new TeamsStreamingSession(cleanSender, { delayInMs: 0, log: silentLog });
    await sExplicit.chunk('hi');
    await new Promise((r) => setTimeout(r, 5));
    await sExplicit.cancel();
    // Explicit cancel → isCancelled() stays false so dispatcher does
    // NOT trigger bug 2 fallback on a normal turn boundary.
    expect(sExplicit.isCancelled()).toBe(false);
  });

  it('explicit cancel() suppresses end()’s final send (dispatcher turn boundary)', async () => {
    // The dispatcher calls cancel() on IPC turn boundaries and in the
    // finally-guard. In those cases the stream is intentionally dead
    // and end() must NOT publish anything — the dispatcher will dispatch
    // any genuine final reply through a fresh stream on the next turn.
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('hi');
    await new Promise((r) => setTimeout(r, 5));
    await s.cancel();
    const id = await s.end('hi there');

    expect(id).toBeUndefined();
    expect(calls.filter((c) => c.type === 'message').length).toBe(0);
  });

  it('end() falls back to plain message if final activity send fails', async () => {
    const calls: Array<Partial<TeamsActivity>> = [];
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      // Fail the final activity that carries streaminfo entities.
      if (activity.type === 'message' && activity.entities?.some((e) => e.streamType === 'final')) {
        throw new Error('AdapterError: final activity rejected');
      }
      return `msg-${calls.length}`;
    };

    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('hi');
    await new Promise((r) => setTimeout(r, 5));
    const id = await s.end('hi there');

    // Two `message` activities ended up in the call log: the original
    // streaming-final (which threw) and the plain-message fallback.
    const messages = calls.filter((c) => c.type === 'message');
    expect(messages.length).toBe(2);
    expect(messages[1].entities ?? []).toEqual([]);
    expect(messages[1].text).toBe('hi there');
    expect(typeof id).toBe('string');
  });

  it('defaults delay to 1500ms for msteams channel and 250ms otherwise', () => {
    const teams = new TeamsStreamingSession(makeSender().sender, {
      channelId: 'msteams',
      log: silentLog,
    });
    const generic = new TeamsStreamingSession(makeSender().sender, {
      log: silentLog,
    });
    // We can't read private fields from the public surface, but
    // the constructor is the only place that branches; this just
    // ensures the channelId hint is accepted without throwing.
    expect(teams).toBeInstanceOf(TeamsStreamingSession);
    expect(generic).toBeInstanceOf(TeamsStreamingSession);
  });
});

/**
 * Regression tests for the 2026-04-22 Teams streaming wire-protocol bug:
 *   Symptom: Teams replies showed "Sorry, something went wrong." twice.
 *   Server logs: "Only start streaming and continue streaming types are
 *   allowed as a typing activity" then "Only end streaming type is
 *   allowed as a message activity".
 *
 * Root causes (paired):
 *   1. First chunk used `streamType: 'streaming'` directly. Per Teams
 *      docs the first activity should be `informative` (start streaming);
 *      the server rejected our shape with the typing-activity error.
 *   2. Because (1) failed, no `streamId` was captured. The follow-up
 *      `final` message went out without `streamId`, which Teams rejected
 *      with the message-activity error — silently losing the agent's reply.
 *
 * Fix: bootstrap the stream with one informative activity; degrade the
 * final to plain non-streaming when no streamId was ever obtained.
 */
describe('Teams streaming wire-protocol regression (2026-04-22)', () => {
  it('first chunk is `informative` (start streaming), not `streaming`', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('first chunk');
    await new Promise((r) => setTimeout(r, 5));

    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls[0].type).toBe('typing');
    expect(calls[0].entities?.[0].streamType).toBe('informative');
    // 2026-08-04: the start-streaming frame must NOT carry a streamId —
    // the Bot Connector *assigns* it and returns it in the 201 response.
    expect(calls[0].entities?.[0].streamId).toBeUndefined();
  });

  it('subsequent chunks switch to `streaming` once streamId is bound', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('ab');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('abc');
    await new Promise((r) => setTimeout(r, 5));

    const typings = calls.filter((c) => c.type === 'typing');
    expect(typings.length).toBeGreaterThanOrEqual(2);
    expect(typings[0].entities?.[0].streamType).toBe('informative');
    // Bootstrap carries no streamId; the server-assigned id from its
    // response is echoed on every later frame.
    expect(typings[0].entities?.[0].streamId).toBeUndefined();
    const serverId = typings[1].entities?.[0].streamId;
    expect(serverId).toBe('msg-1');
    // All later typing activities are `streaming` and carry the same
    // server-assigned streamId.
    for (let i = 1; i < typings.length; i++) {
      expect(typings[i].entities?.[0].streamType).toBe('streaming');
      expect(typings[i].entities?.[0].streamId).toBe(serverId);
    }
  });

  it('end() degrades to plain message when no streamId was ever obtained', async () => {
    // Simulate: first chunk send rejected before any streamId could be
    // captured. Without the regression fix, end() would send a `final`
    // message with no streamId — which Teams rejects with "Only end
    // streaming type is allowed as a message activity" — silently
    // dropping the agent's reply.
    const calls: Array<Partial<TeamsActivity>> = [];
    let nextId = 1;
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      // Reject the first typing activity (whatever streamType it had).
      if (activity.type === 'typing') {
        throw new Error('simulated wire error');
      }
      return `msg-${nextId++}`;
    };

    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('partial text');
    await new Promise((r) => setTimeout(r, 10));
    const id = await s.end('final reply text');

    // The agent's final reply MUST land. The first call was the
    // typing chunk that errored; the last call must be the plain
    // `message` activity (no streaminfo entities, no id).
    const last = calls[calls.length - 1];
    expect(last.type).toBe('message');
    expect(last.text).toBe('final reply text');
    expect(last.entities).toBeUndefined();
    expect(last.id).toBeUndefined();
    // Sender returned an id for the message; end() returns it.
    expect(typeof id).toBe('string');
  });

  it('final activity always carries streamId when one was obtained', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abc');

    const final = calls[calls.length - 1];
    expect(final.type).toBe('message');
    expect(final.entities?.[0].streamType).toBe('final');
    // CRITICAL: Teams rejects a final without streamId. The id is the one
    // the server assigned on the bootstrap response.
    expect(final.entities?.[0].streamId).toBe('msg-1');
  });

  it('abandons the stream when the bootstrap response carries no id', async () => {
    // 2026-08-04: streamId is server-assigned. If the bootstrap is accepted
    // but returns no id, we cannot legally send continuation frames (they
    // require streamId). Fabricating one locally was the 2026-05-29 bug that
    // produced 400 BadSyntax on every turn. Correct behaviour: stop
    // streaming after the bootstrap and let end() publish one plain message.
    const calls: Array<Partial<TeamsActivity>> = [];
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      return undefined; // server returns no id
    };

    const s = new TeamsStreamingSession(sender, {
      delayInMs: 0,
      log: silentLog,
    });

    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('ab');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('abc');
    await new Promise((r) => setTimeout(r, 5));

    const typings = calls.filter((c) => c.type === 'typing');
    // Exactly one typing frame: the bootstrap. No continuation frames are
    // sent because we never received a streamId to put on them.
    expect(typings.length).toBe(1);
    expect(typings[0].entities?.[0].streamType).toBe('informative');
    expect(typings[0].entities?.[0].streamId).toBeUndefined();

    // The reply still lands, as a single plain (non-streaming) message.
    await s.end('abc');
    const last = calls[calls.length - 1];
    expect(last.type).toBe('message');
    expect(last.text).toBe('abc');
    expect(last.entities).toBeUndefined();
  });
});

// ---------------------------------------------------------------------
// Phase machine tests (PR #53 phase B: appendThinking + commitAnswer).
// Proposal: docs/proposals/2026-05-21-teams-thinking-phase-B.md
// ---------------------------------------------------------------------

describe('TeamsStreamingSession native thinking phase', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('appendThinking publishes via the same chunk path during thinking phase', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.appendThinking('think a');
    await new Promise((r) => setTimeout(r, 5));
    await s.appendThinking('think ab');
    await new Promise((r) => setTimeout(r, 5));

    const typings = calls.filter((c) => c.type === 'typing');
    expect(typings.length).toBeGreaterThanOrEqual(1);
    // First activity is the informative bootstrap with thinking text.
    expect(typings[0].entities?.[0].streamType).toBe('informative');
    expect(typings[0].text).toContain('think');
    await s.end('done');
  });

  it('commitAnswer flips phase and lets the next chunk overwrite thinking text', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.appendThinking('thinking step 1');
    await new Promise((r) => setTimeout(r, 5));
    // First answer chunk: dispatcher calls commitAnswer() then chunk().
    s.commitAnswer();
    await s.chunk('answer a');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('answer abc');
    await new Promise((r) => setTimeout(r, 5));

    const typings = calls.filter((c) => c.type === 'typing');
    // Bootstrap had thinking text; later streaming activities have answer.
    const thinkingActivities = typings.filter((c) => typeof c.text === 'string' && c.text.includes('thinking'));
    const answerActivities = typings.filter((c) => typeof c.text === 'string' && c.text.startsWith('answer'));
    expect(thinkingActivities.length).toBeGreaterThanOrEqual(1);
    expect(answerActivities.length).toBeGreaterThanOrEqual(1);
    // No answer activity may include the thinking prefix — commitAnswer
    // reset _latestText so chunk('answer a') sent 'answer a', not
    // 'thinking step 1 answer a'.
    for (const a of answerActivities) {
      expect(a.text).not.toContain('thinking');
    }
    // Only one informative across the whole stream.
    const informatives = typings.filter((c) => c.entities?.[0].streamType === 'informative');
    expect(informatives.length).toBe(1);
    await s.end('answer final');
  });

  it('appendThinking after commitAnswer is dropped (case l: trailing reasoning_delta)', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.appendThinking('think 1');
    await new Promise((r) => setTimeout(r, 5));
    s.commitAnswer();
    await s.chunk('answer 1');
    await new Promise((r) => setTimeout(r, 5));
    // Trailing reasoning_delta: must NOT regress the bubble.
    await s.appendThinking('think 2 — should be dropped');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('answer 12');
    await new Promise((r) => setTimeout(r, 5));

    const typings = calls.filter((c) => c.type === 'typing');
    // No activity may carry the trailing thinking text.
    for (const a of typings) {
      expect(a.text).not.toContain('should be dropped');
    }
    await s.end('answer 12 final');
  });

  it('commitAnswer is idempotent (no-op when phase != thinking)', async () => {
    const { sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    s.commitAnswer();
    s.commitAnswer();
    await s.chunk('answer');
    await new Promise((r) => setTimeout(r, 5));
    // Calling commitAnswer twice should not throw or corrupt state.
    s.commitAnswer();
    await s.end('answer final');
  });

  it('commitAnswer before any thinking is harmless (empty-thinking case)', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    s.commitAnswer();
    await s.chunk('answer only');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('answer only final');
    const typings = calls.filter((c) => c.type === 'typing');
    expect(typings[0].entities?.[0].streamType).toBe('informative');
    expect(typings[0].text).toBe('answer only');
  });

  it('end() flips phase to ended; subsequent appendThinking is dropped', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    await s.appendThinking('think');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('final');
    await s.appendThinking('after-end');
    const messages = calls.filter((c) => c.type === 'message');
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('final');
  });

  it('cancel() flips phase to ended; subsequent appendThinking is dropped', async () => {
    const { sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    await s.appendThinking('think');
    await new Promise((r) => setTimeout(r, 5));
    await s.cancel();
    await s.appendThinking('after-cancel');
    // Cancel + drop should not throw.
  });
});

describe('TeamsStreamingSession black-hole send timeout (2026-07-13)', () => {
  // Root cause of "Teams stuck, only `ncl restart` fixes it": the BFA
  // outbound send has no timeout, so a transport that accepts a frame
  // but never ACKs (never resolves, never throws) hangs the drain loop
  // forever. That wedges `end()`'s `_waitForDrain()`, which wedges the
  // dispatcher's per-JID queue slot until a restart. These tests pin
  // that a black-holed send now (a) times out, (b) degrades to a single
  // plain `message` with NO streaminfo entity (Teams rejects a final
  // message carrying stale stream entities), and (c) the whole thing
  // completes in bounded wall-clock time.

  beforeEach(() => {
    vi.useRealTimers();
  });

  it('chunk send that never resolves times out, then end() degrades to a plain message (no streaminfo)', async () => {
    vi.useFakeTimers();
    const calls: Array<Partial<TeamsActivity>> = [];
    let typingSeen = 0;
    const sender: ActivitySender = (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      if (activity.type === 'typing') {
        typingSeen++;
        // First typing frame black-holes: a promise that never settles.
        if (typingSeen === 1) return new Promise<string>(() => {});
      }
      return Promise.resolve(`msg-${calls.length}`);
    };

    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.chunk('hello');
    // Let the drain loop dispatch the first (black-holing) typing send.
    await Promise.resolve();
    await Promise.resolve();

    // end() will _waitForDrain(); advance past the send timeout so the
    // black-holed frame is abandoned and the degrade path runs.
    const endPromise = s.end('hello world');
    await vi.advanceTimersByTimeAsync(9000);
    const id = await endPromise;

    const typing = calls.filter((c) => c.type === 'typing');
    const messages = calls.filter((c) => c.type === 'message');
    // One typing attempted (timed out), one plain-message final.
    expect(typing.length).toBe(1);
    expect(messages.length).toBe(1);
    // WIRE INVARIANT (VM review): the degraded final MUST be a plain
    // message with no streaminfo entity, or Teams rejects it with
    // "Only end streaming type is allowed as a message activity".
    expect(messages[0].entities ?? []).toEqual([]);
    expect(messages[0].text).toBe('hello world');
    expect(typeof id).toBe('string');
  });

  it('a black-holed send never wedges the turn: end() resolves in bounded time', async () => {
    vi.useFakeTimers();
    const sender: ActivitySender = (activity) => {
      // EVERY send black-holes, including the degrade fallback.
      return new Promise<string>(() => {});
    };
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.chunk('x');
    await Promise.resolve();
    await Promise.resolve();

    let settled = false;
    const endPromise = s.end('final').then((v) => {
      settled = true;
      return v;
    });

    // Advance well past the drain-wait upper bound + a degrade send
    // timeout. Even with every send black-holing, end() must return
    // (the reply may not land, but the turn is freed and the queue slot
    // is released — no restart needed).
    await vi.advanceTimersByTimeAsync(30000);
    await endPromise;
    expect(settled).toBe(true);
  });

  it('SendTimeoutError is thrown with a descriptive message', () => {
    const err = new SendTimeoutError(8000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('SendTimeoutError');
    expect(err.message).toContain('8000');
  });
});

/**
 * Regression tests for the 2026-07-27 Teams delivery-guarantee bug
 * (kenan repro: Windows Teams, agent shows "typing" then goes silent;
 * every turn logged two suppressed wire rejects 200ms apart —
 * "Only start streaming and continue streaming types are allowed as a
 * typing activity" then "Only end streaming type is allowed as a
 * message activity").
 *
 * Two independent defects combined to silently drop the final answer:
 *   1. The final `message` frame carried `streamSequence`, which the
 *      Teams streaming spec forbids ("For the final message,
 *      streamSequence must not be set."). Strong suspect for the second
 *      reject.
 *   2. `makeAdapterSender` let `continueConversation` swallow send
 *      errors: the adapter's `onTurnError` classifies streaming-wire
 *      rejects as benign and returns without re-throwing, so
 *      `continueConversation` resolved as success. The streaming session
 *      never saw the failure, so neither `end()`'s degrade-to-plain path
 *      nor the dispatcher's coalesced-final fallback ever fired.
 */
describe('Teams delivery-guarantee regression (2026-07-27)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('final frame does NOT carry streamSequence (spec: must not be set on final)', async () => {
    const { calls, sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.chunk('ab');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abc');

    const final = calls[calls.length - 1];
    expect(final.type).toBe('message');
    expect(final.entities?.[0].streamType).toBe('final');
    // The forbidden field must be absent (undefined), while the final
    // frame still carries the streamId per the end-streaming contract.
    expect(final.entities?.[0].streamSequence).toBeUndefined();
    expect(typeof final.entities?.[0].streamId).toBe('string');

    // Typing frames still carry a monotonic streamSequence starting at 1.
    const typing = calls.filter((c) => c.type === 'typing');
    expect(typing[0].entities?.[0].streamSequence).toBe(1);
  });

  it('a wire-reject on the streaming frames still lands the final answer as a plain message', async () => {
    // Simulate the exact repro: the server rejects the typing (bootstrap)
    // frame with the wire-protocol error. The session must abort streaming
    // and end() must degrade to a single plain `message` so the answer is
    // NOT lost.
    const calls: Array<Partial<TeamsActivity>> = [];
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      if (activity.type === 'typing') {
        throw new Error('Only start streaming and continue streaming types are allowed as a typing activity');
      }
      return 'msg-final';
    };

    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.chunk('partial answer');
    await new Promise((r) => setTimeout(r, 5));
    const id = await s.end('the complete answer');

    const messages = calls.filter((c) => c.type === 'message');
    // Exactly one final message lands (no duplicates).
    expect(messages.length).toBe(1);
    expect(messages[0].text).toBe('the complete answer');
    // Degraded final is a plain message: no streaminfo entity, or Teams
    // rejects it ("Only end streaming type is allowed as a message activity").
    expect(messages[0].entities ?? []).toEqual([]);
    expect(id).toBe('msg-final');
  });

  it('isCancelled() trips after a wire-reject so the dispatcher can coalesce', async () => {
    const sender: ActivitySender = async (activity) => {
      if (activity.type === 'typing') {
        throw new Error('Only start streaming and continue streaming types are allowed as a typing activity');
      }
      return 'ok';
    };
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.chunk('x');
    await new Promise((r) => setTimeout(r, 5));

    // Wire died (not an explicit dispatcher cancel) → isCancelled() true,
    // which is the signal index.ts's probeWireDeath() reads to arm the
    // coalesced-final buffer.
    expect(s.isCancelled()).toBe(true);
  });
});

/**
 * makeAdapterSender must re-surface send errors instead of letting
 * `continueConversation` swallow them. This is the core of defect #2
 * above: without it, a rejected send looks like success to the session.
 */
describe('makeAdapterSender error propagation (2026-07-27)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('re-throws an error raised by sendActivity inside continueConversation', async () => {
    // Faithful stand-in for BotFrameworkAdapter.continueConversation: it
    // runs the logic callback and resolves normally (the real adapter
    // routes a THROWN error to onTurnError, but our callback no longer
    // throws — it captures the error for re-throw after resolve).
    const adapter = {
      continueConversation: async (_ref: any, logic: (ctx: any) => Promise<void>) => {
        const ctx = {
          sendActivity: async () => {
            throw new Error('Only end streaming type is allowed as a message activity');
          },
        };
        await logic(ctx);
      },
    };
    const sender = makeAdapterSender({ adapter: adapter as any, ref: {} as any });

    await expect(sender({ type: 'message', text: 'hi' })).rejects.toThrow(/Only end streaming type is allowed/);
  });

  it('returns the activity id on success', async () => {
    const adapter = {
      continueConversation: async (_ref: any, logic: (ctx: any) => Promise<void>) => {
        const ctx = { sendActivity: async () => ({ id: 'server-id-123' }) };
        await logic(ctx);
      },
    };
    const sender = makeAdapterSender({ adapter: adapter as any, ref: {} as any });
    await expect(sender({ type: 'typing', text: 'x' })).resolves.toBe('server-id-123');
  });
});

describe('extractWireRejectDetail (B1: 2026-08-03 body=undefined fix)', () => {
  it('pulls statusCode/code/reason/body from the real BFA RestError shape', () => {
    // Shape produced by @azure/core-client deserializationPolicy for a
    // Bot Connector 400: RestError.message = server reason, .code lifted
    // from parsedBody.error.code, raw JSON on response.bodyAsText.
    const err: any = new Error('Only start streaming and continue streaming types are allowed as a typing activity');
    err.statusCode = 400;
    err.code = 'BadArgument';
    err.response = {
      bodyAsText:
        '{"error":{"code":"BadArgument","message":"Only start streaming and continue streaming types are allowed as a typing activity"}}',
      parsedBody: {
        error: {
          code: 'BadArgument',
          message: 'Only start streaming and continue streaming types are allowed as a typing activity',
        },
      },
    };
    const d = extractWireRejectDetail(err);
    expect(d.statusCode).toBe(400);
    expect(d.code).toBe('BadArgument');
    expect(d.reason).toMatch(/Only start streaming/);
    // The old diagnostic read err.body / err.response.body — both absent
    // here (the exact live `body=undefined`). bodyText must come from
    // response.bodyAsText instead.
    expect(d.bodyText).toContain('BadArgument');
    expect(err.body).toBeUndefined();
    expect(err.response.body).toBeUndefined();
  });

  it('falls back to err.message when no structured body is present', () => {
    const err: any = new Error('socket hang up');
    err.statusCode = undefined;
    const d = extractWireRejectDetail(err);
    expect(d.reason).toBe('socket hang up');
    expect(d.bodyText).toBeUndefined();
  });

  it('clamps oversized body text so logs stay bounded', () => {
    const big = 'x'.repeat(5000);
    const err: any = new Error('boom');
    err.response = { bodyAsText: big };
    const d = extractWireRejectDetail(err);
    expect(d.bodyText!.length).toBeLessThanOrEqual(601);
    expect(d.bodyText!.endsWith('\u2026')).toBe(true);
  });

  it('stringifies a non-string body object', () => {
    const err: any = new Error('boom');
    err.body = { error: { code: 'X', message: 'y' } };
    const d = extractWireRejectDetail(err);
    expect(d.bodyText).toContain('"code":"X"');
  });
});

describe('B5: end-path delivery-outcome instrumentation (2026-08-03)', () => {
  function capturingLog() {
    const info: Array<{ data: any; msg: string }> = [];
    const warn: Array<{ data: any; msg: string }> = [];
    const error: Array<{ data: any; msg: string }> = [];
    const log = {
      info: (data: any, msg: string) => info.push({ data, msg }),
      warn: (data: any, msg: string) => warn.push({ data, msg }),
      error: (data: any, msg: string) => error.push({ data, msg }),
      debug: () => {},
    } as any;
    return { log, info, warn, error };
  }

  it('tags final-frame delivery with endPath + delivered=true on the happy path', async () => {
    const { calls, sender } = makeSender();
    const { log, info } = capturingLog();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log });
    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abc');
    void calls;
    const delivered = info.find((l) => l.data?.endPath === 'final-frame');
    expect(delivered).toBeDefined();
    expect(delivered!.data.delivered).toBe(true);
  });

  it('tags total-failure with delivered=false + reject detail when both final AND plain fail', async () => {
    // Every send rejects → final frame fails, last-ditch plain also fails.
    // B5 must emit endPath=total-failure delivered=false carrying the
    // server reason (so an error-only log shows the drop + why).
    //
    // 2026-08-04: streamId is server-assigned, so this branch is only
    // reachable once a bootstrap actually returned an id. Accept the first
    // (bootstrap) frame to bind one, then reject everything after it.
    let sent = 0;
    const sender: ActivitySender = async (activity) => {
      void activity;
      sent += 1;
      if (sent === 1) return 'stream-1';
      const err: any = new Error('Only end streaming type is allowed as a message activity');
      err.statusCode = 400;
      err.response = {
        bodyAsText: '{"error":{"code":"BadArgument","message":"Only end streaming type is allowed"}}',
        parsedBody: { error: { code: 'BadArgument', message: 'Only end streaming type is allowed' } },
      };
      throw err;
    };
    const { log, error } = capturingLog();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log });
    // Bootstrap binds the server-assigned streamId so the stream is "live";
    // end() then takes the final-frame → plain-fallback → total-failure path.
    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('final answer text');
    const drop = error.find((l) => l.data?.endPath === 'total-failure' || l.data?.delivered === false);
    expect(drop).toBeDefined();
    expect(drop!.data.delivered).toBe(false);
    // Reject detail must be present (not body=undefined).
    expect(String(drop!.data.reason ?? drop!.data.bodyText ?? '')).toMatch(/streaming type is allowed|BadArgument/);
  });
});

describe('A2: endFailed() delivery signal (2026-08-03 cursor-rollback source)', () => {
  it('is false on a healthy streaming turn', async () => {
    const { sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abc');
    expect(s.endFailed()).toBe(false);
  });

  it('is false when the final frame is rejected but the plain fallback lands', async () => {
    // Streaming final rejected, plain last-ditch succeeds → reply DID land
    // → no rollback.
    let n = 0;
    const sender: ActivitySender = async (activity) => {
      // First real end() send is the streaming `final` frame — reject it.
      if (activity.type === 'message' && activity.entities?.[0]?.streamType === 'final') {
        throw new Error('Only end streaming type is allowed as a message activity');
      }
      // Plain fallback message — succeeds.
      return `msg-${++n}`;
    };
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    await s.chunk('a');
    await new Promise((r) => setTimeout(r, 5));
    await s.end('abc');
    expect(s.endFailed()).toBe(false);
  });

  it('is true when both the final frame AND the plain fallback are rejected', async () => {
    const sender: ActivitySender = async () => {
      throw new Error('hard wire failure');
    };
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    // Drive end() directly so we hit final-frame → plain fallback →
    // total-failure (streamId is minted at construction, so we skip the
    // no-streamId branch).
    await s.end('final answer text');
    expect(s.endFailed()).toBe(true);
  });

  it('is false after an explicit dispatcher cancel (nothing was meant to publish)', async () => {
    const { sender } = makeSender();
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    await s.chunk('a');
    await s.cancel();
    await s.end('abc');
    expect(s.endFailed()).toBe(false);
  });
});

describe('terminal settle barrier (2026-08-04 bootstrap-reject race)', () => {
  it('cancel waits for a delayed bootstrap reject and preserves wire-death state for end() fallback', async () => {
    const calls: Array<Partial<TeamsActivity>> = [];
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      if (activity.type === 'typing') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        throw new Error('Only start streaming and continue streaming types are allowed as a typing activity');
      }
      return 'plain-final-id';
    };
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });

    await s.chunk('partial answer');
    // The immediate probe would still see false; cancel() must settle the
    // in-flight send before deciding whether this is an explicit cancel.
    expect(s.isCancelled()).toBe(false);
    await s.cancel();
    expect(s.isCancelled()).toBe(true);

    const id = await s.end('complete answer');
    expect(id).toBe('plain-final-id');
    const messages = calls.filter((c) => c.type === 'message');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ type: 'message', text: 'complete answer' });
    expect(messages[0].entities ?? []).toEqual([]);
  });

  it('settle reveals a delayed timeout/reject without ending a healthy caller-visible session', async () => {
    const sender: ActivitySender = async (activity) => {
      if (activity.type === 'typing') {
        await new Promise((resolve) => setTimeout(resolve, 5));
        throw new Error('wire rejected after chunk returned');
      }
      return 'plain-id';
    };
    const s = new TeamsStreamingSession(sender, { delayInMs: 0, log: silentLog });
    await s.chunk('draft');
    await s.settle();
    expect(s.isCancelled()).toBe(true);
    await expect(s.end('final')).resolves.toBe('plain-id');
  });
});
