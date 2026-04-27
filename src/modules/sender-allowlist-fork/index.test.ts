/**
 * Sender allowlist (fork add-on) module skeleton — verifies the fork
 * allowlist helpers are reachable through the v2 module path. Real
 * gate wiring is deferred to B.5 (router merge).
 */
import { describe, it, expect } from 'vitest';

import { senderAllowlistFork } from './index.js';

describe('sender-allowlist-fork module skeleton', () => {
  it('re-exports the fork allowlist helpers', () => {
    expect(typeof senderAllowlistFork.isSenderAllowed).toBe('function');
    expect(typeof senderAllowlistFork.loadSenderAllowlist).toBe('function');
  });

  it('isSenderAllowed defaults to allow-all when chat config is absent', () => {
    const cfg = {
      default: { allow: '*' as const, mode: 'trigger' as const },
      chats: {},
      logDenied: false,
    };
    expect(
      senderAllowlistFork.isSenderAllowed('any-chat', 'anyone', cfg),
    ).toBe(true);
  });

  it('isSenderAllowed honours per-chat allow lists', () => {
    const cfg = {
      default: { allow: [] as string[], mode: 'drop' as const },
      chats: {
        'g1': { allow: ['alice'] as string[], mode: 'trigger' as const },
      },
      logDenied: false,
    };
    expect(senderAllowlistFork.isSenderAllowed('g1', 'alice', cfg)).toBe(true);
    expect(senderAllowlistFork.isSenderAllowed('g1', 'mallory', cfg)).toBe(
      false,
    );
  });
});
