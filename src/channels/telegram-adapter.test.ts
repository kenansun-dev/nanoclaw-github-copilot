/**
 * Tests for the v2 Telegram adapter (`./telegram-adapter.ts`).
 *
 * Goal: verify the adapter wraps fork's `TelegramChannel` correctly
 * and forwards inbound/outbound through the v2 surface, without
 * actually connecting to Telegram (we mock the inner TelegramChannel).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import type { NewMessage } from '../types-extensions.js';

// Mock fork TelegramChannel so we never open a real bot connection.
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSendMessage = vi.fn().mockResolvedValue('123');
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockSetTyping = vi.fn().mockResolvedValue(undefined);

let capturedOnMessage: ((chatJid: string, message: NewMessage) => void) | null = null;
let capturedOnChatMetadata:
  | ((jid: string, ts: string, name: string, channel: string, isGroup: boolean) => void)
  | null = null;
let capturedAccountId: string | undefined;

vi.mock('./telegram.js', () => {
  class FakeTelegramChannel {
    constructor(_token: string, opts: any, accountId?: string) {
      capturedOnMessage = opts.onMessage;
      capturedOnChatMetadata = opts.onChatMetadata;
      capturedAccountId = accountId;
    }
    connect = mockConnect;
    disconnect = mockDisconnect;
    sendMessage = mockSendMessage;
    isConnected = mockIsConnected;
    setTyping = mockSetTyping;
  }
  return { TelegramChannel: FakeTelegramChannel };
});

// Import AFTER the mock so the registration fires against the mocked module.
import { TelegramV2Adapter, chatJidToPlatformId } from './telegram-adapter.js';

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

describe('TelegramV2Adapter', () => {
  beforeEach(() => {
    capturedOnMessage = null;
    capturedOnChatMetadata = null;
    capturedAccountId = undefined;
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockSendMessage.mockClear();
    mockSetTyping.mockClear();
  });

  it('exposes correct v2 contract metadata', () => {
    const a = new TelegramV2Adapter('fake-token');
    expect(a.name).toBe('telegram');
    expect(a.channelType).toBe('telegram');
    expect(a.supportsThreads).toBe(false);
    expect(a.isConnected()).toBe(false);
  });

  it('chatJidToPlatformId strips both single and account-scoped tg prefixes', () => {
    expect(chatJidToPlatformId('tg:12345')).toBe('12345');
    expect(chatJidToPlatformId('tg:my-account:12345')).toBe('12345');
  });

  it('setup connects the wrapped TelegramChannel and forwards accountId', async () => {
    const a = new TelegramV2Adapter('fake-token', 'acct-1');
    const { cfg } = makeSetup();
    await a.setup(cfg);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(capturedAccountId).toBe('acct-1');
    expect(a.isConnected()).toBe(true);
  });

  it('translates fork NewMessage into v2 InboundMessage on inbound', async () => {
    const a = new TelegramV2Adapter('fake-token');
    const { cfg, inbound } = makeSetup();
    await a.setup(cfg);
    expect(capturedOnMessage).not.toBeNull();

    capturedOnMessage!('tg:12345', {
      id: 'msg-1',
      chat_jid: 'tg:12345',
      sender: 'user-id',
      sender_name: 'alice',
      content: '@Andy hello',
      timestamp: '2026-04-28T00:00:00.000Z',
      reply_to_message_id: 'prev-msg',
      reply_to_sender_name: 'bob',
    });

    expect(inbound).toHaveLength(1);
    expect(inbound[0].platformId).toBe('12345');
    expect(inbound[0].threadId).toBeNull();
    const c = inbound[0].message.content as Record<string, unknown>;
    expect(c.text).toBe('@Andy hello');
    expect(c.senderName).toBe('alice');
    expect(c.replyToMessageId).toBe('prev-msg');
  });

  it('forwards onChatMetadata into v2 onMetadata', async () => {
    const a = new TelegramV2Adapter('fake-token');
    const { cfg, metadata } = makeSetup();
    await a.setup(cfg);
    expect(capturedOnChatMetadata).not.toBeNull();

    capturedOnChatMetadata!('tg:99', '2026-04-28T00:00:00.000Z', 'My Group', 'telegram', true);

    expect(metadata).toHaveLength(1);
    expect(metadata[0].platformId).toBe('99');
    expect(metadata[0].name).toBe('My Group');
    expect(metadata[0].isGroup).toBe(true);
  });

  it('deliver routes plain string content through sendMessage', async () => {
    const a = new TelegramV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    const id = await a.deliver('555', null, {
      kind: 'chat',
      content: 'hello world',
    });
    expect(mockSendMessage).toHaveBeenCalledWith('tg:555', 'hello world');
    expect(id).toBe('123');
  });

  it('deliver uses account-scoped jid when accountId is set', async () => {
    const a = new TelegramV2Adapter('fake-token', 'acct-2');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('555', null, { kind: 'chat', content: 'hi' });
    expect(mockSendMessage).toHaveBeenCalledWith('tg:acct-2:555', 'hi');
  });

  it('deliver extracts text from object content', async () => {
    const a = new TelegramV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('666', null, {
      kind: 'chat',
      content: { text: 'boxed reply' },
    });
    expect(mockSendMessage).toHaveBeenCalledWith('tg:666', 'boxed reply');
  });

  it('deliver skips when no text payload found', async () => {
    const a = new TelegramV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('777', null, { kind: 'card', content: { foo: 'bar' } });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('teardown disconnects the wrapped channel', async () => {
    const a = new TelegramV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);
    await a.teardown();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(a.isConnected()).toBe(false);
  });
});
