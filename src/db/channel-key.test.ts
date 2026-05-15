import { describe, it, expect } from 'vitest';
import {
  channelKeyToType,
  typeToChannelKey,
  synthLegacyJid,
  splitJid,
  jidToTypeAndPlatformId,
} from './channel-key.js';

describe('channel-key bridging', () => {
  describe('channelKeyToType', () => {
    it('maps tg → telegram', () => expect(channelKeyToType('tg')).toBe('telegram'));
    it('passes telegram/discord/teams/whatsapp/slack/matrix/email through', () => {
      for (const t of ['telegram', 'discord', 'teams', 'whatsapp', 'slack', 'matrix', 'email']) {
        expect(channelKeyToType(t)).toBe(t);
      }
    });
    it('canonicalizes iMessage → imessage', () => expect(channelKeyToType('iMessage')).toBe('imessage'));
    it('passes tui through', () => expect(channelKeyToType('tui')).toBe('tui'));
    it('passes unknown channels through unchanged', () => expect(channelKeyToType('nostr')).toBe('nostr'));
  });

  describe('typeToChannelKey', () => {
    it('maps telegram → tg (the only rewrite)', () => expect(typeToChannelKey('telegram')).toBe('tg'));
    it('passes everything else through', () => {
      for (const t of ['discord', 'teams', 'whatsapp', 'slack', 'matrix', 'imessage', 'tui', 'email', 'nostr']) {
        expect(typeToChannelKey(t)).toBe(t);
      }
    });
  });

  describe('synthLegacyJid (v2 → v1 jid)', () => {
    it('telegram + numeric platform_id', () => {
      expect(synthLegacyJid('telegram', '8731187021')).toBe('tg:8731187021');
    });
    it('preserves multi-colon platform_id (Teams thread)', () => {
      expect(synthLegacyJid('teams', 'a:1Rw3-S4Le_nHy4oLPqvBSqG3iXslDKGBqTtN5NYrmLC65tgjeivzoJDJwzg')).toBe(
        'teams:a:1Rw3-S4Le_nHy4oLPqvBSqG3iXslDKGBqTtN5NYrmLC65tgjeivzoJDJwzg',
      );
    });
    it('preserves multi-colon platform_id (daily-prefix telegram)', () => {
      expect(synthLegacyJid('telegram', 'daily:8731187021')).toBe('tg:daily:8731187021');
    });
    it('handles tui:default', () => {
      expect(synthLegacyJid('tui', 'default')).toBe('tui:default');
    });
    it('handles negative-id telegram groups', () => {
      expect(synthLegacyJid('telegram', '-100crew')).toBe('tg:-100crew');
    });
  });

  describe('splitJid', () => {
    it('splits on first colon only', () => {
      expect(splitJid('teams:a:1Rw3')).toEqual(['teams', 'a:1Rw3']);
      expect(splitJid('tg:daily:8731187021')).toEqual(['tg', 'daily:8731187021']);
    });
    it('returns null on malformed', () => {
      expect(splitJid('nocolons')).toBeNull();
      expect(splitJid(':leading')).toBeNull();
      expect(splitJid('trailing:')).toBeNull();
    });
  });

  describe('round-trip (live rpi5 jid samples)', () => {
    const samples = [
      'tg:8731187021',
      'tg:-4937542884',
      'tg:daily:8731187021',
      'teams:a:1Rw3-S4Le_nHy4oLPqvBSqG3iXslDKGBqTtN5NYrmLC65tgjeivzoJDJwzg',
      'tui:default',
      'tg:99999',
    ];
    for (const jid of samples) {
      it(`jid ${jid} → (type, platform_id) → jid stays equal`, () => {
        const decoded = jidToTypeAndPlatformId(jid);
        expect(decoded).not.toBeNull();
        const composed = synthLegacyJid(decoded!.channelType, decoded!.platformId);
        expect(composed).toBe(jid);
      });
    }
  });
});
