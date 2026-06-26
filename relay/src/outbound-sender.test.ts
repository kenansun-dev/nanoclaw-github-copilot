import { describe, it, expect, vi } from 'vitest';
import { makeOutboundSender, isRetryableConnectorStatus, buildConnectorUrl } from './outbound-sender.js';
import type { OutboundReplyInput } from './contract.js';

const reply = (over: Partial<OutboundReplyInput> = {}): OutboundReplyInput => ({
  botId: 'prod',
  inReplyTo: 'act-1',
  activityJson: new TextEncoder().encode(JSON.stringify({ conversation: { id: 'c1' }, replyToId: 'r1' })),
  serviceUrl: 'https://smba.trafficmanager.net/amer/',
  clientMsgId: 'm1',
  ...over,
});

describe('isRetryableConnectorStatus', () => {
  it('429 + 5xx retryable; 4xx + 2xx not', () => {
    expect(isRetryableConnectorStatus(429)).toBe(true);
    expect(isRetryableConnectorStatus(503)).toBe(true);
    expect(isRetryableConnectorStatus(500)).toBe(true);
    expect(isRetryableConnectorStatus(401)).toBe(false);
    expect(isRetryableConnectorStatus(403)).toBe(false);
    expect(isRetryableConnectorStatus(404)).toBe(false);
    expect(isRetryableConnectorStatus(200)).toBe(false);
  });
});

describe('buildConnectorUrl', () => {
  it('builds the reply-to-activity path from serviceUrl + activity', () => {
    const a = new TextEncoder().encode(JSON.stringify({ conversation: { id: 'c1' }, replyToId: 'r1' }));
    expect(buildConnectorUrl('https://smba/amer/', a)).toBe('https://smba/amer/v3/conversations/c1/activities/r1');
  });
  it('omits the replyTo segment when absent', () => {
    const a = new TextEncoder().encode(JSON.stringify({ conversation: { id: 'c2' } }));
    expect(buildConnectorUrl('https://smba/amer', a)).toBe('https://smba/amer/v3/conversations/c2/activities');
  });
  it('tolerates non-JSON activity (empty ids)', () => {
    expect(buildConnectorUrl('https://smba/', new TextEncoder().encode('x'))).toBe('https://smba/v3/conversations//activities');
  });
});

describe('makeOutboundSender (#5)', () => {
  it('returns a non-retryable misconfig result when MSI client id is unset', async () => {
    const s = makeOutboundSender({ msiClientId: undefined });
    const r = await s.deliverOutbound(reply());
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.error).toMatch(/MSI_CLIENT_ID|misconfigured/i);
  });

  it('rejects an outbound reply with no serviceUrl (non-retryable)', async () => {
    const s = makeOutboundSender({ msiClientId: 'msi-1' });
    const r = await s.deliverOutbound(reply({ serviceUrl: '' }));
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(false);
    expect(r.error).toMatch(/serviceUrl/);
  });

  it('encodes the federation stub as a retryable failure (not a throw)', async () => {
    // Default exchangeForBotToken throws NOT_IMPLEMENTED; IMDS is stubbed ok.
    const s = makeOutboundSender({
      msiClientId: 'msi-1',
      fetchImdsToken: async () => 'imds-assertion',
    });
    const r = await s.deliverOutbound(reply());
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.error).toMatch(/NOT_IMPLEMENTED.*onboarding/);
  });

  it('POSTs to the Connector and reports ok on 2xx', async () => {
    const httpPost = vi.fn(async () => ({ status: 201 }));
    const s = makeOutboundSender({
      msiClientId: 'msi-1',
      fetchImdsToken: async () => 'imds',
      exchangeForBotToken: async () => 'bot-token',
      httpPost,
    });
    const r = await s.deliverOutbound(reply());
    expect(r.ok).toBe(true);
    expect(r.connectorStatus).toBe(201);
    expect(r.retryable).toBe(false);
    const [url, token] = httpPost.mock.calls[0];
    expect(url).toBe('https://smba.trafficmanager.net/amer/v3/conversations/c1/activities/r1');
    expect(token).toBe('bot-token');
  });

  it('maps a Connector 429 to retryable=true', async () => {
    const s = makeOutboundSender({
      msiClientId: 'msi-1',
      fetchImdsToken: async () => 'imds',
      exchangeForBotToken: async () => 'bot-token',
      httpPost: async () => ({ status: 429 }),
    });
    const r = await s.deliverOutbound(reply());
    expect(r.ok).toBe(false);
    expect(r.connectorStatus).toBe(429);
    expect(r.retryable).toBe(true);
  });

  it('maps a Connector 401 to retryable=false', async () => {
    const s = makeOutboundSender({
      msiClientId: 'msi-1',
      fetchImdsToken: async () => 'imds',
      exchangeForBotToken: async () => 'bot-token',
      httpPost: async () => ({ status: 401 }),
    });
    const r = await s.deliverOutbound(reply());
    expect(r.connectorStatus).toBe(401);
    expect(r.retryable).toBe(false);
  });

  it('treats a Connector network throw as retryable', async () => {
    const s = makeOutboundSender({
      msiClientId: 'msi-1',
      fetchImdsToken: async () => 'imds',
      exchangeForBotToken: async () => 'bot-token',
      httpPost: async () => {
        throw new Error('ECONNRESET');
      },
    });
    const r = await s.deliverOutbound(reply());
    expect(r.ok).toBe(false);
    expect(r.retryable).toBe(true);
    expect(r.error).toMatch(/ECONNRESET/);
  });
});
