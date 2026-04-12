/**
 * Tests for multi-account Telegram routing:
 * - chatJid format with accountId
 * - ownsJid scoping per account
 * - numericId extraction from both JID formats
 */
import { describe, it, expect } from 'vitest';

// Test chatJid format helper logic (mirrors TelegramChannel.chatJid)
function chatJid(accountId: string | undefined, chatId: number): string {
  return accountId && accountId !== 'default'
    ? `tg:${accountId}:${chatId}`
    : `tg:${chatId}`;
}

// Test ownsJid logic (mirrors TelegramChannel.ownsJid)
function ownsJid(accountId: string | undefined, jid: string): boolean {
  if (!jid.startsWith('tg:')) return false;
  if (accountId && accountId !== 'default') {
    const parts = jid.split(':');
    return parts.length >= 3 && parts[1] === accountId;
  }
  const parts = jid.split(':');
  return parts.length === 2;
}

// Test numericId extraction (mirrors sendMessage logic)
function extractChatId(jid: string): string {
  return jid.split(':').pop()!;
}

describe('multi-account Telegram routing', () => {
  describe('chatJid format', () => {
    it('default account produces tg:<chatId>', () => {
      expect(chatJid(undefined, 123456)).toBe('tg:123456');
      expect(chatJid('default', 123456)).toBe('tg:123456');
    });

    it('non-default account produces tg:<accountId>:<chatId>', () => {
      expect(chatJid('daily', 123456)).toBe('tg:daily:123456');
      expect(chatJid('coder', 789)).toBe('tg:coder:789');
    });

    it('different accounts produce different JIDs for same chat', () => {
      const a = chatJid('daily', 123456);
      const b = chatJid('default', 123456);
      const c = chatJid(undefined, 123456);
      expect(a).not.toBe(b);
      expect(b).toBe(c); // default and undefined are equivalent
    });

    it('handles negative chat IDs (Telegram groups)', () => {
      expect(chatJid('daily', -4937542884)).toBe('tg:daily:-4937542884');
      expect(chatJid(undefined, -4937542884)).toBe('tg:-4937542884');
    });
  });

  describe('ownsJid scoping', () => {
    it('default account owns tg:<chatId> (2 segments)', () => {
      expect(ownsJid(undefined, 'tg:123456')).toBe(true);
      expect(ownsJid('default', 'tg:123456')).toBe(true);
    });

    it('default account does NOT own tg:<accountId>:<chatId> (3 segments)', () => {
      expect(ownsJid(undefined, 'tg:daily:123456')).toBe(false);
      expect(ownsJid('default', 'tg:daily:123456')).toBe(false);
    });

    it('non-default account owns tg:<accountId>:<chatId> with matching accountId', () => {
      expect(ownsJid('daily', 'tg:daily:123456')).toBe(true);
    });

    it('non-default account does NOT own tg:<chatId> (no prefix)', () => {
      expect(ownsJid('daily', 'tg:123456')).toBe(false);
    });

    it('non-default account does NOT own other accounts JIDs', () => {
      expect(ownsJid('daily', 'tg:coder:123456')).toBe(false);
    });

    it('neither account owns non-tg JIDs', () => {
      expect(ownsJid(undefined, 'teams:conv-123')).toBe(false);
      expect(ownsJid('daily', 'wa:123')).toBe(false);
    });

    it('two accounts never both own the same JID', () => {
      const jids = ['tg:123456', 'tg:daily:123456', 'tg:coder:123456'];
      for (const jid of jids) {
        const owners = ['default', 'daily', 'coder'].filter((a) =>
          ownsJid(a === 'default' ? undefined : a, jid),
        );
        expect(owners.length).toBeLessThanOrEqual(1);
      }
    });
  });

  describe('numericId extraction', () => {
    it('extracts from tg:<chatId>', () => {
      expect(extractChatId('tg:123456')).toBe('123456');
    });

    it('extracts from tg:<accountId>:<chatId>', () => {
      expect(extractChatId('tg:daily:123456')).toBe('123456');
    });

    it('extracts negative IDs', () => {
      expect(extractChatId('tg:-4937542884')).toBe('-4937542884');
      expect(extractChatId('tg:daily:-4937542884')).toBe('-4937542884');
    });
  });
});
