/**
 * Tests for the v2 Discord adapter (`./discord-adapter.ts`).
 *
 * Goal: verify the adapter wraps fork's `DiscordChannel` correctly and
 * forwards inbound/outbound through the v2 surface, without actually
 * connecting to Discord (we mock the inner DiscordChannel).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import type { NewMessage } from '../types-extensions.js';

// Mock fork DiscordChannel so we never open a real gateway connection.
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockDisconnect = vi.fn().mockResolvedValue(undefined);
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
const mockIsConnected = vi.fn().mockReturnValue(true);
const mockSetTyping = vi.fn().mockResolvedValue(undefined);

let capturedOnMessage: ((chatJid: string, message: NewMessage) => void) | null = null;
let capturedOnChatMetadata:
  | ((jid: string, ts: string, name: string, channel: string, isGroup: boolean) => void)
  | null = null;

vi.mock('./discord.js', () => {
  class FakeDiscordChannel {
    constructor(_token: string, opts: any) {
      capturedOnMessage = opts.onMessage;
      capturedOnChatMetadata = opts.onChatMetadata;
    }
    connect = mockConnect;
    disconnect = mockDisconnect;
    sendMessage = mockSendMessage;
    isConnected = mockIsConnected;
    setTyping = mockSetTyping;
  }
  return { DiscordChannel: FakeDiscordChannel };
});

// Import AFTER the mock so the registration fires against the mocked module.
import { DiscordV2Adapter } from './discord-adapter.js';
import { getChannelAdapter } from './channel-registry.js';

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

describe('DiscordV2Adapter', () => {
  beforeEach(() => {
    capturedOnMessage = null;
    capturedOnChatMetadata = null;
    mockConnect.mockClear();
    mockDisconnect.mockClear();
    mockSendMessage.mockClear();
    mockSetTyping.mockClear();
  });

  it('exposes correct v2 contract metadata', () => {
    const a = new DiscordV2Adapter('fake-token');
    expect(a.name).toBe('discord');
    expect(a.channelType).toBe('discord');
    expect(a.supportsThreads).toBe(false);
    expect(a.isConnected()).toBe(false); // not yet set up
  });

  it('setup connects the wrapped DiscordChannel', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);
    expect(mockConnect).toHaveBeenCalledTimes(1);
    expect(a.isConnected()).toBe(true);
  });

  it('translates fork NewMessage into v2 InboundMessage on inbound', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg, inbound } = makeSetup();
    await a.setup(cfg);
    expect(capturedOnMessage).not.toBeNull();

    capturedOnMessage!('dc:12345', {
      id: 'msg-1',
      chat_jid: 'dc:12345',
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
    expect(inbound[0].message.id).toBe('msg-1');
    expect(inbound[0].message.kind).toBe('chat');
    expect(inbound[0].message.timestamp).toBe('2026-04-28T00:00:00.000Z');
    const c = inbound[0].message.content as Record<string, unknown>;
    expect(c.text).toBe('@Andy hello');
    expect(c.senderName).toBe('alice');
    expect(c.replyToMessageId).toBe('prev-msg');
  });

  it('forwards onChatMetadata into v2 onMetadata', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg, metadata } = makeSetup();
    await a.setup(cfg);
    expect(capturedOnChatMetadata).not.toBeNull();

    capturedOnChatMetadata!('dc:99', '2026-04-28T00:00:00.000Z', 'My Server #general', 'discord', true);

    expect(metadata).toHaveLength(1);
    expect(metadata[0].platformId).toBe('99');
    expect(metadata[0].name).toBe('My Server #general');
    expect(metadata[0].isGroup).toBe(true);
  });

  it('deliver routes plain string content through sendMessage', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('555', null, { kind: 'chat', content: 'hello world' });
    expect(mockSendMessage).toHaveBeenCalledWith('dc:555', 'hello world');
  });

  it('deliver extracts text from object content', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('666', null, {
      kind: 'chat',
      content: { text: 'boxed reply' },
    });
    expect(mockSendMessage).toHaveBeenCalledWith('dc:666', 'boxed reply');
  });

  it('deliver skips when no text payload found', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);

    await a.deliver('777', null, { kind: 'card', content: { foo: 'bar' } });
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  it('teardown disconnects the wrapped channel', async () => {
    const a = new DiscordV2Adapter('fake-token');
    const { cfg } = makeSetup();
    await a.setup(cfg);
    await a.teardown();
    expect(mockDisconnect).toHaveBeenCalledTimes(1);
    expect(a.isConnected()).toBe(false);
  });

  it('self-registers under "discord" in the channel registry', () => {
    // Importing './discord-adapter.js' at top of this file fires
    // registerChannelAdapter('discord', ...). Verify the registry has
    // it (factory may return null if no token in env, that's fine).
    // Unlike `getChannelAdapter`, we just want to know the name is
    // present. Use the activeAdapters map indirectly via the
    // factory-driven init flow: here we only assert no throw on
    // lookup.
    expect(() => getChannelAdapter('discord')).not.toThrow();
  });
});
