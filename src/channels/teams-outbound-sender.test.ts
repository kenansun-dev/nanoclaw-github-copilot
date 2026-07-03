/**
 * Unit tests for the Teams outbound sender abstraction (L2 seam).
 *
 * These assert the *layering contract* Kenan required: the relay sender is a
 * pure transport shim that forwards Teams activities verbatim as opaque
 * payload, without inspecting or mutating any Teams semantics (streamId,
 * streamType, entities, text, …). The Teams streaming state machine (L3)
 * therefore rides the proxy unchanged.
 */
import { describe, it, expect, vi } from 'vitest';
import { makeRelaySender } from './teams-outbound-sender.js';
import type { RelayOutbound } from './teams-relay-client.js';

function fakeClient() {
  const sent: RelayOutbound[] = [];
  return {
    sent,
    client: {
      sendReply: vi.fn((r: RelayOutbound) => {
        sent.push(r);
        return true;
      }),
    },
  };
}

describe('makeRelaySender — transport-agnostic L2 seam', () => {
  it('forwards the activity verbatim (opaque payload, no field inspection)', async () => {
    const { client, sent } = fakeClient();
    const sender = makeRelaySender({
      client,
      botId: 'bot-app-1',
      serviceUrl: 'https://smba.example/teams',
      inReplyTo: 'inbound-42',
    });

    const activity = {
      type: 'message' as const,
      text: 'hello',
      id: 'local-stream-id',
      entities: [{ type: 'streaminfo', streamId: 'local-stream-id', streamType: 'final' }],
    };
    await sender(activity);

    expect(sent).toHaveLength(1);
    // Activity object handed through untouched — same reference, unmutated.
    expect(sent[0].activity).toBe(activity);
    expect(sent[0].activity).toEqual({
      type: 'message',
      text: 'hello',
      id: 'local-stream-id',
      entities: [{ type: 'streaminfo', streamId: 'local-stream-id', streamType: 'final' }],
    });
    expect(sent[0].botId).toBe('bot-app-1');
    expect(sent[0].serviceUrl).toBe('https://smba.example/teams');
    expect(sent[0].inReplyTo).toBe('inbound-42');
  });

  it('mints a fresh idempotency clientMsgId per frame', async () => {
    const { client, sent } = fakeClient();
    const sender = makeRelaySender({ client, botId: 'b', serviceUrl: 'u' });

    await sender({ type: 'typing' });
    await sender({ type: 'typing' });

    expect(sent[0].clientMsgId).toBeTruthy();
    expect(sent[1].clientMsgId).toBeTruthy();
    expect(sent[0].clientMsgId).not.toBe(sent[1].clientMsgId);
  });

  it('defaults inReplyTo to empty string for proactive sends', async () => {
    const { client, sent } = fakeClient();
    const sender = makeRelaySender({ client, botId: 'b', serviceUrl: 'u' });
    await sender({ type: 'message', text: 'proactive' });
    expect(sent[0].inReplyTo).toBe('');
  });

  it('echoes a locally-set activity id (streamId) back to the caller', async () => {
    const { client } = fakeClient();
    const sender = makeRelaySender({ client, botId: 'b', serviceUrl: 'u' });
    const id = await sender({ type: 'message', id: 'minted-123' });
    expect(id).toBe('minted-123');
  });

  it('returns undefined when the activity has no local id (no connector id over relay)', async () => {
    const { client } = fakeClient();
    const sender = makeRelaySender({ client, botId: 'b', serviceUrl: 'u' });
    const id = await sender({ type: 'typing' });
    expect(id).toBeUndefined();
  });

  it('throws on a detached stream so the L3 degrade/retry path engages', async () => {
    const client = { sendReply: vi.fn(() => false) };
    const sender = makeRelaySender({ client, botId: 'b', serviceUrl: 'u' });
    await expect(sender({ type: 'message', text: 'x' })).rejects.toThrow(/detached/);
  });

  it('carries a full 3-frame streaming sequence unchanged (informative→streaming→final)', async () => {
    const { client, sent } = fakeClient();
    const sender = makeRelaySender({ client, botId: 'b', serviceUrl: 'u', inReplyTo: 'in-1' });

    // Same activity shapes the L3 streaming session emits; sender must not care.
    await sender({ type: 'typing', id: 'sid', entities: [{ type: 'streaminfo', streamId: 'sid', streamType: 'informative' }] } as any);
    await sender({ type: 'typing', id: 'sid', entities: [{ type: 'streaminfo', streamId: 'sid', streamType: 'streaming' }] } as any);
    await sender({ type: 'message', text: 'done', id: 'sid', entities: [{ type: 'streaminfo', streamId: 'sid', streamType: 'final' }] } as any);

    expect(sent.map((s) => (s.activity as any).entities[0].streamType)).toEqual([
      'informative',
      'streaming',
      'final',
    ]);
    // All three carry the same locally-minted streamId, untouched by L2.
    expect(new Set(sent.map((s) => (s.activity as any).id))).toEqual(new Set(['sid']));
    // Distinct idempotency keys per frame.
    expect(new Set(sent.map((s) => s.clientMsgId)).size).toBe(3);
  });
});
