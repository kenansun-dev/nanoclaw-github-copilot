/**
 * Tests for router.ts — message formatting, outbound processing,
 * channel routing, and XML escaping.
 *
 * These are pure functions with no side effects — ideal for unit testing.
 */
import { describe, it, expect } from 'vitest';
import {
  escapeXml,
  formatMessages,
  formatConversationContext,
  stripInternalTags,
  formatOutbound,
  findChannel,
} from './text-format.js';
import { Channel, NewMessage } from './types-extensions.js';

// ─── escapeXml ───────────────────────────────────────────────────────────────

describe('escapeXml', () => {
  it('escapes & < >', () => {
    expect(escapeXml('a & b < c > d')).toBe('a &amp; b &lt; c &gt; d');
  });

  it('returns empty string for falsy input', () => {
    expect(escapeXml('')).toBe('');
    expect(escapeXml(null as any)).toBe('');
    expect(escapeXml(undefined as any)).toBe('');
  });

  it('passes through clean text unchanged', () => {
    expect(escapeXml('hello world')).toBe('hello world');
  });

  it('handles multiple entities', () => {
    expect(escapeXml('<<>>')).toBe('&lt;&lt;&gt;&gt;');
  });
});

// ─── stripInternalTags ───────────────────────────────────────────────────────

describe('stripInternalTags', () => {
  it('strips <internal>...</internal> tags', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiline internal tags', () => {
    expect(
      stripInternalTags('before\n<internal>\nline1\nline2\n</internal>\nafter'),
    ).toBe('before\n\nafter');
  });

  it('strips multiple internal blocks', () => {
    expect(
      stripInternalTags('a <internal>x</internal> b <internal>y</internal> c'),
    ).toBe('a  b  c');
  });

  it('returns original text when no internal tags', () => {
    expect(stripInternalTags('no tags here')).toBe('no tags here');
  });

  it('returns empty string when only internal content', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });
});

// ─── formatOutbound ──────────────────────────────────────────────────────────

describe('formatOutbound', () => {
  it('strips internal tags from output', () => {
    expect(formatOutbound('hello <internal>hidden</internal> world')).toBe(
      'hello  world',
    );
  });

  it('returns empty string for only-internal content', () => {
    expect(formatOutbound('<internal>all hidden</internal>')).toBe('');
  });

  it('passes through clean text', () => {
    expect(formatOutbound('hello world')).toBe('hello world');
  });

  it('trims whitespace after stripping', () => {
    expect(formatOutbound('  <internal>x</internal>  hello  ')).toBe('hello');
  });
});

// ─── formatMessages ──────────────────────────────────────────────────────────

describe('formatMessages', () => {
  const makeMsg = (overrides: Partial<NewMessage>): NewMessage => ({
    id: 'msg-1',
    chat_jid: 'tg:123',
    sender: 'user1',
    sender_name: 'Alice',
    content: 'hello',
    timestamp: '2026-04-05T10:00:00.000Z',
    is_from_me: false,
    ...overrides,
  });

  it('formats a single message with sender and time', () => {
    const result = formatMessages([makeMsg({})], 'UTC');
    expect(result).toContain('Alice');
    expect(result).toContain('hello');
  });

  it('formats multiple messages in order', () => {
    const msgs = [
      makeMsg({
        sender_name: 'Alice',
        content: 'first',
        timestamp: '2026-04-05T10:00:00.000Z',
      }),
      makeMsg({
        sender_name: 'Bob',
        content: 'second',
        timestamp: '2026-04-05T10:01:00.000Z',
      }),
    ];
    const result = formatMessages(msgs, 'UTC');
    expect(result.indexOf('first')).toBeLessThan(result.indexOf('second'));
  });

  it('returns formatted output for empty array', () => {
    const result = formatMessages([], 'UTC');
    // May return XML wrapper or empty — just verify no crash
    expect(typeof result).toBe('string');
  });
});

// ─── formatConversationContext ────────────────────────────────────────────────

describe('formatConversationContext', () => {
  it('returns empty string for empty messages', () => {
    expect(formatConversationContext([], 'UTC', 'Bot')).toBe('');
  });

  it('includes sender names in context', () => {
    const msgs = [
      {
        sender_name: 'Alice',
        content: 'hi',
        timestamp: '2026-04-05T10:00:00.000Z',
        is_from_me: false,
      },
    ];
    const result = formatConversationContext(msgs, 'UTC', 'Bot');
    expect(result).toContain('Alice');
    expect(result).toContain('hi');
  });

  it('labels bot messages with bot prefix', () => {
    const msgs = [
      {
        sender_name: 'Bot',
        content: 'I am bot',
        timestamp: '2026-04-05T10:00:00.000Z',
        is_from_me: true,
      },
    ];
    const result = formatConversationContext(msgs, 'UTC', 'Bot');
    expect(result).toContain('Bot');
    expect(result).toContain('I am bot');
  });
});

// ─── findChannel ─────────────────────────────────────────────────────────────

describe('findChannel', () => {
  const makeChannel = (prefix: string): Channel => ({
    name: prefix,
    ownsJid: (jid: string) => jid.startsWith(`${prefix}:`),
    connect: async () => {},
    disconnect: async () => {},
    sendMessage: async () => undefined,
    isConnected: () => true,
  });

  it('finds channel by JID prefix', () => {
    const channels = [makeChannel('tg'), makeChannel('teams')];
    expect(findChannel(channels, 'tg:123')?.name).toBe('tg');
    expect(findChannel(channels, 'teams:abc')?.name).toBe('teams');
  });

  it('returns undefined for unknown JID', () => {
    const channels = [makeChannel('tg')];
    expect(findChannel(channels, 'wa:123')).toBeUndefined();
  });

  it('returns first match when multiple channels match', () => {
    const ch1: Channel = { ...makeChannel('tg'), name: 'tg-1' };
    const ch2: Channel = { ...makeChannel('tg'), name: 'tg-2' };
    expect(findChannel([ch1, ch2], 'tg:123')?.name).toBe('tg-1');
  });

  it('returns undefined for empty channels array', () => {
    expect(findChannel([], 'tg:123')).toBeUndefined();
  });
});
