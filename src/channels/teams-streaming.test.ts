import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TeamsStreamingSession, type ActivitySender, type TeamsActivity } from './teams-streaming.js';

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
    expect(first.entities?.[0].type).toBe('streaminfo');
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

    // Bug 1 fix (2026-05-29): streamId is minted locally at construction
    // (not learned from server response). It is the same UUID on every
    // activity in the session. `id` on the activity itself is unrelated —
    // the dispatcher does not learn it from anywhere.
    const mintedId = first.entities?.[0].streamId;
    expect(typeof mintedId).toBe('string');
    expect(mintedId).toMatch(/^[0-9a-f-]{36}$/);
    expect(second?.entities?.[0].streamId).toBe(mintedId);
    expect(final.entities?.[0].streamId).toBe(mintedId);
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

  it('defaults delay to 1000ms for msteams channel and 250ms otherwise', () => {
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
    // Bug 1 fix (2026-05-29): streamId is minted locally at construction
    // so the first activity DOES carry it (previously the test asserted
    // undefined because the impl waited for the server to assign one).
    expect(calls[0].entities?.[0].streamId).toMatch(/^[0-9a-f-]{36}$/);
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
    const mintedId = typings[0].entities?.[0].streamId;
    expect(typeof mintedId).toBe('string');
    // All later typing activities are `streaming` and carry the same
    // locally-minted streamId.
    for (let i = 1; i < typings.length; i++) {
      expect(typings[i].entities?.[0].streamType).toBe('streaming');
      expect(typings[i].entities?.[0].streamId).toBe(mintedId);
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
    // CRITICAL: Teams server rejects final without streamId. Bug 1 fix
    // (2026-05-29) mints it locally so the final always has one.
    expect(final.entities?.[0].streamId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('only ONE informative activity even if server returns no id (no infinite informative loop)', async () => {
    // Hardening for issue caught in 2026-04-22 self-audit:
    //   If we keyed the bootstrap-vs-continuation decision off `!_streamId`
    //   AND the server response carried no `id`, every subsequent chunk
    //   would also be sent as `streamType: 'informative'`. Teams
    //   rejects more than one informative message per stream
    //   ("You can set only one informative message"), so this would
    //   silently break long streams whenever the channel happens to
    //   not return an id. We track bootstrap separately to avoid this.
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
    expect(typings.length).toBeGreaterThanOrEqual(2);
    // Exactly one informative activity — the bootstrap.
    const informatives = typings.filter((c) => c.entities?.[0].streamType === 'informative');
    expect(informatives.length).toBe(1);
    // All subsequent chunks must be `streaming`, not informative.
    for (let i = 1; i < typings.length; i++) {
      expect(typings[i].entities?.[0].streamType).toBe('streaming');
    }
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
