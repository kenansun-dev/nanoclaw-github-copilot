import { describe, it, expect, beforeEach } from 'vitest';
import { makeBroker, type Broker, type AttachedStream, type InboundDelivery, type OverflowNotice, type AuditRecord } from './broker.js';
import type { InboundActivityInput } from './contract.js';

/**
 * Broker core tests (Rpi5 #4). The decoupling model is load-bearing, so this
 * enumerates the state combinations: live-route vs buffer, TTL expiry, capacity
 * drop, flush-on-attach (incl. expired-during-absence), detach, last-writer
 * stream replacement, and overflow coalescing.
 */

let clock = 0;
const now = () => clock;
let idSeq = 0;
const genId = () => `id${idSeq++}`;

function activity(botId: string, json = 'x'): InboundActivityInput {
  return {
    botId,
    activityJson: new TextEncoder().encode(json),
    serviceUrl: 'https://smba.example/',
    receivedUnixMs: clock,
  };
}

function recorder() {
  const inbound: InboundDelivery[] = [];
  const overflow: OverflowNotice[] = [];
  const stream = (sessionId: string, botIds: string[]): AttachedStream => ({
    sessionId,
    botIds,
    pushInbound: (d) => inbound.push(d),
    pushOverflow: (n) => overflow.push(n),
  });
  return { inbound, overflow, stream };
}

let audit: AuditRecord[] = [];
function makeT(opts: Partial<Parameters<typeof makeBroker>[0]> = {}): Broker {
  return makeBroker({ now, genId, audit: (r) => audit.push(r), bufferTtlMs: 1000, bufferMaxPerBot: 3, ...opts });
}

beforeEach(() => {
  clock = 0;
  idSeq = 0;
  audit = [];
});

describe('broker: live routing', () => {
  it('routes to an attached stream, marks fromBuffer=false', async () => {
    const t = makeT();
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    await t.enqueueInbound(activity('botA'));
    expect(r.inbound).toHaveLength(1);
    expect(r.inbound[0]).toMatchObject({ botId: 'botA', fromBuffer: false });
    expect(audit.at(-1)?.event).toBe('routed_live');
    t.stop();
  });

  it('does not throw and buffers when no stream attached (the "no NCL" path)', async () => {
    const t = makeT();
    await expect(t.enqueueInbound(activity('botA'))).resolves.toBeUndefined();
    expect(t.bufferedCount('botA')).toBe(1);
    expect(audit.at(-1)?.event).toBe('buffered');
    t.stop();
  });
});

describe('broker: buffer flush on attach', () => {
  it('flushes non-expired buffered items FIFO with fromBuffer=true', async () => {
    const t = makeT();
    await t.enqueueInbound(activity('botA', 'first'));
    await t.enqueueInbound(activity('botA', 'second'));
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    expect(r.inbound).toHaveLength(2);
    expect(r.inbound.every((d) => d.fromBuffer)).toBe(true);
    expect(new TextDecoder().decode(r.inbound[0].activityJson)).toBe('first');
    expect(t.bufferedCount('botA')).toBe(0);
    t.stop();
  });

  it('drops items that expired during NCL absence, flushes the rest, sends overflow', async () => {
    const t = makeT();
    await t.enqueueInbound(activity('botA', 'old'));
    clock = 1500; // first item (exp 1000) now expired
    await t.enqueueInbound(activity('botA', 'fresh')); // exp 2500
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    expect(r.inbound).toHaveLength(1);
    expect(new TextDecoder().decode(r.inbound[0].activityJson)).toBe('fresh');
    expect(r.overflow).toEqual([{ botId: 'botA', droppedCount: 1, reason: 'ttl_expired' }]);
    t.stop();
  });
});

describe('broker: TTL sweep without attach', () => {
  it('expires buffered items via the periodic sweep', async () => {
    const t = makeT();
    await t.enqueueInbound(activity('botA'));
    expect(t.bufferedCount('botA')).toBe(1);
    clock = 2000;
    // Trigger sweep manually by advancing — sweep runs on interval; emulate by
    // attaching after expiry which also sweeps.
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    expect(r.inbound).toHaveLength(0);
    expect(r.overflow).toEqual([{ botId: 'botA', droppedCount: 1, reason: 'ttl_expired' }]);
    t.stop();
  });
});

describe('broker: capacity drop', () => {
  it('drops oldest when exceeding bufferMaxPerBot', async () => {
    const t = makeT(); // max 3
    await t.enqueueInbound(activity('botA', '1'));
    await t.enqueueInbound(activity('botA', '2'));
    await t.enqueueInbound(activity('botA', '3'));
    await t.enqueueInbound(activity('botA', '4')); // drops '1'
    expect(t.bufferedCount('botA')).toBe(3);
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    const texts = r.inbound.map((d) => new TextDecoder().decode(d.activityJson));
    expect(texts).toEqual(['2', '3', '4']);
    expect(r.overflow.some((o) => o.reason === 'capacity' && o.droppedCount >= 1)).toBe(true);
    t.stop();
  });
});

describe('broker: detach + last-writer replacement', () => {
  it('after detach, inbound buffers again', async () => {
    const t = makeT();
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    t.detachStream('s1');
    await t.enqueueInbound(activity('botA'));
    expect(t.bufferedCount('botA')).toBe(1);
    expect(r.inbound).toHaveLength(0);
    t.stop();
  });

  it('a newer attach for the same bot replaces the old; detaching the old stream does not clear the new mapping', async () => {
    const t = makeT();
    const r1 = recorder();
    const r2 = recorder();
    t.attachStream(r1.stream('s1', ['botA']));
    t.attachStream(r2.stream('s2', ['botA'])); // replaces botA→s2
    t.detachStream('s1'); // must NOT remove botA→s2
    await t.enqueueInbound(activity('botA'));
    expect(r2.inbound).toHaveLength(1);
    expect(r1.inbound).toHaveLength(0);
    t.stop();
  });
});

describe('broker: overflow coalescing while absent', () => {
  it('coalesces drop counts and delivers on next attach', async () => {
    const t = makeT(); // max 3
    for (const n of ['1', '2', '3', '4', '5']) await t.enqueueInbound(activity('botA', n)); // 2 capacity drops
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    const totalDropped = r.overflow.reduce((s, o) => s + o.droppedCount, 0);
    expect(totalDropped).toBeGreaterThanOrEqual(2);
    t.stop();
  });
});

describe('broker: multi-bot isolation', () => {
  it('a stream only receives its own bots', async () => {
    const t = makeT();
    await t.enqueueInbound(activity('botA'));
    await t.enqueueInbound(activity('botB'));
    const r = recorder();
    t.attachStream(r.stream('s1', ['botA']));
    expect(r.inbound).toHaveLength(1);
    expect(r.inbound[0].botId).toBe('botA');
    expect(t.bufferedCount('botB')).toBe(1);
    t.stop();
  });
});
