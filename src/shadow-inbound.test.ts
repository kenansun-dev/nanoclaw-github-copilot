import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  parseChatJid,
  toInboundEvent,
  shadowRoute,
  __setShadowRouterForTests,
} from './shadow-inbound.js';
import type { NewMessage } from './types-extensions.js';

const baseMsg: NewMessage = {
  id: 'm-1',
  chat_jid: 'dc:1234',
  sender: 'u-1',
  sender_name: 'Alice',
  content: 'hi',
  timestamp: '2026-04-29T00:00:00Z',
};

describe('parseChatJid', () => {
  it('parses discord', () => {
    expect(parseChatJid('dc:1234567890')).toEqual({
      channelType: 'discord',
      platformId: '1234567890',
    });
  });
  it('parses telegram', () => {
    expect(parseChatJid('tg:-100abc')).toEqual({
      channelType: 'telegram',
      platformId: '-100abc',
    });
  });
  it('parses teams', () => {
    expect(parseChatJid('teams:thread-id')).toEqual({
      channelType: 'teams',
      platformId: 'thread-id',
    });
  });
  it('parses tui', () => {
    expect(parseChatJid('tui:default')).toEqual({
      channelType: 'tui',
      platformId: 'default',
    });
  });
  it('returns null for unknown prefix', () => {
    expect(parseChatJid('mystery:foo')).toBeNull();
    expect(parseChatJid('foo')).toBeNull();
  });
});

describe('toInboundEvent', () => {
  it('builds an InboundEvent matching discord-adapter shape', () => {
    const event = toInboundEvent('dc:999', baseMsg);
    expect(event).not.toBeNull();
    expect(event!.channelType).toBe('discord');
    expect(event!.platformId).toBe('999');
    expect(event!.threadId).toBeNull();
    expect(event!.message.kind).toBe('chat');
    const parsed = JSON.parse(event!.message.content);
    expect(parsed.text).toBe('hi');
    expect(parsed.sender).toBe('u-1');
    expect(parsed.senderName).toBe('Alice');
  });

  it('returns null for unknown prefix', () => {
    expect(toInboundEvent('foo', baseMsg)).toBeNull();
  });

  it('preserves thread_id when present', () => {
    const event = toInboundEvent('dc:1', { ...baseMsg, thread_id: 'thr-1' });
    expect(event!.threadId).toBe('thr-1');
  });

  it('marks tui as non-group', () => {
    const event = toInboundEvent('tui:default', baseMsg);
    expect(event!.message.isGroup).toBe(false);
  });
});

describe('shadowRoute', () => {
  beforeEach(() => {
    __setShadowRouterForTests(null);
  });

  it('calls the router with a translated event', async () => {
    const router = vi.fn().mockResolvedValue(undefined);
    __setShadowRouterForTests(router);
    shadowRoute('dc:42', baseMsg);
    // microtask flush
    await new Promise((r) => setImmediate(r));
    expect(router).toHaveBeenCalledTimes(1);
    expect(router.mock.calls[0][0].channelType).toBe('discord');
  });

  it('skips outbound (is_from_me) messages', async () => {
    const router = vi.fn();
    __setShadowRouterForTests(router);
    shadowRoute('dc:42', { ...baseMsg, is_from_me: true });
    await new Promise((r) => setImmediate(r));
    expect(router).not.toHaveBeenCalled();
  });

  it('skips unknown jid prefix without throwing', async () => {
    const router = vi.fn();
    __setShadowRouterForTests(router);
    shadowRoute('mystery:foo', baseMsg);
    await new Promise((r) => setImmediate(r));
    expect(router).not.toHaveBeenCalled();
  });

  it('swallows router errors without rethrowing', async () => {
    const router = vi.fn().mockRejectedValue(new Error('router blew up'));
    __setShadowRouterForTests(router);
    expect(() => shadowRoute('dc:42', baseMsg)).not.toThrow();
    await new Promise((r) => setImmediate(r));
    expect(router).toHaveBeenCalled();
  });

  it('returns synchronously (fire-and-forget)', () => {
    let resolveRouter: (v: unknown) => void = () => {};
    const router = vi.fn().mockImplementation(
      () =>
        new Promise((res) => {
          resolveRouter = res;
        }),
    );
    __setShadowRouterForTests(router);
    const start = Date.now();
    shadowRoute('dc:42', baseMsg);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(50);
    resolveRouter(undefined);
  });
});
