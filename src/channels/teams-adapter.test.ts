/**
 * Tests for the v2 Teams adapter (`./teams-adapter.ts`).
 *
 * Goal: verify the adapter wraps fork's `TeamsChannel` correctly and
 * forwards inbound/outbound through the v2 surface, without actually
 * binding the BotFramework HTTP server (we mock the inner
 * TeamsChannel).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import type { NewMessage } from '../types.js';

const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSendMessage = vi.fn().mockResolvedValue('teams-msg-1');
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockSetTyping = vi.fn().mockResolvedValue(undefined);

let capturedOnMessage:
  | ((chatJid: string, message: NewMessage) => void)
  | null = null;
let capturedOnChatMetadata:
  | ((
      jid: string,
      ts: string,
      name: string,
      channel: string,
      isGroup: boolean,
    ) => void)
  | null = null;
let capturedCtorArgs: {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  port?: number;
  certThumbprint?: string;
  certPrivateKeyPath?: string;
} = {};

vi.mock('./teams.js', () => {
  class FakeTeamsChannel {
    constructor(
      appId: string,
      appPassword: string | undefined,
      tenantId: string | undefined,
      port: number,
      opts: any,
      certThumbprint?: string,
      certPrivateKeyPath?: string,
    ) {
      capturedCtorArgs = {
        appId,
        appPassword,
        tenantId,
        port,
        certThumbprint,
        certPrivateKeyPath,
      };
      capturedOnMessage = opts.onMessage;
      capturedOnChatMetadata = opts.onChatMetadata;
    }
    connect = mockConnect;
    disconnect = mockDisconnect;
    sendMessage = mockSendMessage;
    isConnected = mockIsConnected;
    setTyping = mockSetTyping;
  }
  return { TeamsChannel: FakeTeamsChannel };
});

import { TeamsV2Adapter } from './teams-adapter.js';

function makeSetup(): {
  cfg: ChannelSetup;
  inbound: Array<{
    platformId: string;
    threadId: string | null;
    message: InboundMessage;
  }>;
  metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }>;
} {
  const inbound: Array<{
    platformId: string;
    threadId: string | null;
    message: InboundMessage;
  }> = [];
  const metadata: Array<{
    platformId: string;
    name?: string;
    isGroup?: boolean;
  }> = [];
  return {
    inbound,
    metadata,
    cfg: {
      onInbound: (platformId, threadId, message) => {
        inbound.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: (platformId, name, isGroup) => {
        metadata.push({ platformId, name, isGroup });
      },
      onAction: () => {},
    },
  };
}

const baseCreds = {
  appId: 'app-id',
  appPassword: 'app-pw',
  tenantId: 'tenant-1',
  port: 3978,
};

describe('TeamsV2Adapter', () => {
  beforeEach(() => {
    capturedOnMessage = null;
    capturedOnChatMetadata = null;
    capturedCtorArgs = {};
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockSendMessage.mockClear();
    mockSetTyping.mockClear();
  });

  it('exposes correct v2 contract metadata', () => {
    const a = new TeamsV2Adapter(baseCreds);
    expect(a.name).toBe('teams');
    expect(a.channelType).toBe('teams');
    expect(a.supportsThreads).toBe(false);
    expect(a.isConnected()).toBe(false);
  });

  it('setup forwards all credential args to TeamsChannel ctor', async () => {
    const a = new TeamsV2Adapter({
      appId: 'app-id',
      appPassword: 'pw',
      tenantId: 'tenant-1',
      port: 4000,
      certThumbprint: 'thumb',
      certPrivateKeyPath: '/key',
    });
    const { cfg } = makeSetup();
    await a.setup(cfg);
    expect(capturedCtorArgs).toEqual({
      appId: 'app-id',
      appPassword: 'pw',
      tenantId: 'tenant-1',
      port: 4000,
      certThumbprint: 'thumb',
      certPrivateKeyPath: '/key',
    });
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(a.isConnected()).toBe(true);
  });

  it('translates fork NewMessage into v2 InboundMessage on inbound', async () => {
    const a = new TeamsV2Adapter(baseCreds);
    const { cfg, inbound } = makeSetup();
    await a.setup(cfg);
    expect(capturedOnMessage).not.toBeNull();

    capturedOnMessage!('teams:conv-abc', {
      id: 'msg-1',
      chat_jid: 'teams:conv-abc',
      sender: 'user-id',
      sender_name: 'alice',
      content: '@Andy hello',
      timestamp: '2026-04-28T00:00:00.000Z',
      reply_to_message_id: 'prev-msg',
      reply_to_sender_name: 'bob',
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0].platformId).toBe('conv-abc');
    expect(inbound[0].threadId).toBeNull();
    expect(inbound[0].message.id).toBe('msg-1');
    const c = inbound[0].message.content as Record<string, unknown>;
    expect(c.text).toBe('@Andy hello');
    expect(c.senderName).toBe('alice');
    expect(c.replyToMessageId).toBe('prev-msg');
  });

  it('forwards onChatMetadata into v2 onMetadata', async () => {
    const a = new TeamsV2Adapter(baseCreds);
    const { cfg, metadata } = makeSetup();
    await a.setup(cfg);
    expect(capturedOnChatMetadata).not.toBeNull();

    capturedOnChatMetadata!(
      'teams:conv-99',
      '2026-04-28T00:00:00.000Z',
      'My Team channel',
      'teams',
      true,
    );

    expect(metadata).toHaveLength(1);
    expect(metadata[0].platformId).toBe('conv-99');
    expect(metadata[0].name).toBe('My Team channel');
    expect(metadata[0].isGroup).toBe(true);
  });

  it('deliver routes plain string content through sendMessage and returns id', async () => {
    const a = new TeamsV2Adapter(baseCreds);
    const { cfg } = makeSetup();
    await a.setup(cfg);

    const id = await a.deliver('conv-555', null, {
      kind: 'chat',
      content: 'hello world',
    });
    expect(mockSendMessage).toHaveBeenCalledWith('teams:conv-555', 'hello world');
    expect(id).toBe('teams-msg-1');
  });

  it('deliver extracts text from object content', async () => {
    const a = new TeamsV2Adapter(baseCreds);
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('conv-666', null, {
      kind: 'chat',
      content: { text: 'boxed reply' },
    });
    expect(mockSendMessage).toHaveBeenCalledWith('teams:conv-666', 'boxed reply');
  });

  it('deliver skips when no text payload found', async () => {
    const a = new TeamsV2Adapter(baseCreds);
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('conv-777', null, {
      kind: 'card',
      content: { foo: 'bar' },
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('teardown disconnects the wrapped channel', async () => {
    const a = new TeamsV2Adapter(baseCreds);
    const { cfg } = makeSetup();
    await a.setup(cfg);
    await a.teardown();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(a.isConnected()).toBe(false);
  });
});
