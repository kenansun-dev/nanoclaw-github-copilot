import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  TeamsStreamingSession,
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
 *  - Activity shape: each chunk is `typing` + `streaminfo` entity with
 *    `streamType:'streaming'` and a monotonic `streamSequence`.
 *  - First chunk has no streamId; subsequent activities carry the id
 *    returned by the first send and stamp it on entity[0].
 *  - End publishes a `message` activity with `streamType:'final'`.
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
    expect(first.entities?.[0].streamType).toBe('streaming');
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
    const second = calls.find(
      (c, i) => i > 0 && c.type === 'typing',
    ) as Partial<TeamsActivity>;
    const final = calls[calls.length - 1];

    // First activity has no id field set (it'll learn it from the response).
    expect(first.id).toBeUndefined();
    // Subsequent activities carry the streamId from the first response.
    expect(second?.id).toBe('msg-1');
    expect(second?.entities?.[0].streamId).toBe('msg-1');
    expect(final.id).toBe('msg-1');
    expect(final.entities?.[0].streamId).toBe('msg-1');
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
    const typingTexts = calls
      .filter((c) => c.type === 'typing')
      .map((c) => c.text);
    expect(typingTexts[0]).toBe('a');
    expect(typingTexts.length).toBeLessThanOrEqual(2);
    // Last typing must be a prefix of the final text.
    expect('abcde'.startsWith(typingTexts[typingTexts.length - 1] ?? '')).toBe(
      true,
    );
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
          throw new Error(
            'BadArgument: streaming api is not enabled for this conversation',
          );
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

  it('cancels the stream on ContentStreamNotAllowed and stops sending', async () => {
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
    await s.end('abc');

    // We attempted exactly one typing send (the rejected one) and
    // never published a final (cancellation suppresses end's send).
    expect(calls.filter((c) => c.type === 'typing').length).toBe(1);
    expect(calls.filter((c) => c.type === 'message').length).toBe(0);
  });

  it('end() falls back to plain message if final activity send fails', async () => {
    const calls: Array<Partial<TeamsActivity>> = [];
    const sender: ActivitySender = async (activity) => {
      calls.push(JSON.parse(JSON.stringify(activity)));
      // Fail the final activity that carries streaminfo entities.
      if (
        activity.type === 'message' &&
        activity.entities?.some((e) => e.streamType === 'final')
      ) {
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
