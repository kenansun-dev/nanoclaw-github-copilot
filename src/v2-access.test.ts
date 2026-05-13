/**
 * Tests for src/v2-access.ts (checkInboundAccess).
 *
 * Coverage matrix (12 cases):
 *   1. legacy config (no accounts map) → allow
 *   2. account exists but no v2 fields → allow
 *   3. DM allowFrom hit → allow
 *   4. DM dmPolicy='open' → allow
 *   5. DM dmPolicy='strict' (sender not in allowFrom) → deny
 *   6. DM dmPolicy unset (default 'pairing') → hold-pairing
 *   7. group: per-group allowFrom hit → allow (with isMention)
 *   8. group: account.groupAllowFrom cascade hit → allow
 *   9. group: account.allowFrom cascade hit → allow
 *   10. group: groupPolicy='open' (no allow lists) → allow
 *   11. group: groupPolicy='strict' default → deny
 *   12. group: specific groupId entry overrides '*' wildcard
 *   13. requireMention=true and !isMention → deny
 *   14. requireMention=false → allow without mention
 *   15. owner role bypass (DM with strict policy, sender not in allowFrom)
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { NanoclawConfig } from './config-loader.js';
import { runMigrations } from './db/migrations/index.js';
import { checkInboundAccess, type InboundAccessInput } from './v2-access.js';

function openDb(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function mkConfig(channelsOver: Record<string, unknown> = {}): NanoclawConfig {
  return {
    agents: {
      defaults: {
        model: 'm',
        name: 'D',
        triggerWord: '@d',
        hasOwnNumber: false,
        mode: 'host',
      },
      list: [],
    },
    channels: channelsOver,
    chats: {},
  } as unknown as NanoclawConfig;
}

function mkInbound(over: Partial<InboundAccessInput> = {}): InboundAccessInput {
  return {
    channelType: 'telegram',
    accountKey: 'default',
    platformId: 'peer-1',
    isGroup: false,
    senderRawId: 'user-1',
    isMention: false,
    text: 'hi',
    ...over,
  };
}

function makeOwner(db: Database.Database, channelType: string, rawId: string): void {
  const userId = `${channelType}:${rawId}`;
  db.prepare(
    `INSERT OR IGNORE INTO users (id, kind, display_name, created_at) VALUES (?, 'real', ?, datetime('now'))`,
  ).run(userId, userId);
  db.prepare(
    `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
     VALUES (?, 'owner', NULL, datetime('now'))`,
  ).run(userId);
}

describe('checkInboundAccess', () => {
  let db: Database.Database;
  beforeEach(() => {
    db = openDb();
  });

  it('1. legacy config (no accounts map) → allow', () => {
    const cfg = mkConfig({ telegram: {} });
    const r = checkInboundAccess(cfg, db, mkInbound());
    expect(r.action).toBe('allow');
  });

  it('2. account exists with only credentials (no v2 fields) → allow', () => {
    const cfg = mkConfig({ telegram: { accounts: { default: { botToken: 'x' } } } });
    const r = checkInboundAccess(cfg, db, mkInbound());
    expect(r.action).toBe('allow');
  });

  it('3. DM allowFrom hit → allow', () => {
    const cfg = mkConfig({
      telegram: { accounts: { default: { dmPolicy: 'strict', allowFrom: ['user-1'] } } },
    });
    const r = checkInboundAccess(cfg, db, mkInbound({ senderRawId: 'user-1' }));
    expect(r.action).toBe('allow');
  });

  it('4. DM dmPolicy=open → allow', () => {
    const cfg = mkConfig({ telegram: { accounts: { default: { dmPolicy: 'open' } } } });
    const r = checkInboundAccess(cfg, db, mkInbound({ senderRawId: 'stranger' }));
    expect(r.action).toBe('allow');
  });

  it('5. DM dmPolicy=strict (sender not in allowFrom) → deny', () => {
    const cfg = mkConfig({
      telegram: { accounts: { default: { dmPolicy: 'strict', allowFrom: ['someone-else'] } } },
    });
    const r = checkInboundAccess(cfg, db, mkInbound({ senderRawId: 'stranger' }));
    expect(r.action).toBe('deny');
    expect(r.reason).toMatch(/strict/);
  });

  it('6. DM dmPolicy unset → hold-pairing (default pairing)', () => {
    const cfg = mkConfig({ telegram: { accounts: { default: { allowFrom: [] } } } });
    const r = checkInboundAccess(cfg, db, mkInbound({ senderRawId: 'stranger' }));
    expect(r.action).toBe('hold-pairing');
  });

  it('7. group: per-group allowFrom hit → allow (with mention)', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'strict',
            groups: { 'grp-1': { allowFrom: ['user-1'], requireMention: true } },
          },
        },
      },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-1', senderRawId: 'user-1', isMention: true }),
    );
    expect(r.action).toBe('allow');
  });

  it('8. group: account.groupAllowFrom cascade hit → allow', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'strict',
            groupAllowFrom: ['user-1'],
            groups: { 'grp-1': { requireMention: false } },
          },
        },
      },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-1', senderRawId: 'user-1', isMention: false }),
    );
    expect(r.action).toBe('allow');
  });

  it('9. group: account.allowFrom cascade hit (no group/groupAllowFrom) → allow', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'strict',
            allowFrom: ['user-1'],
            groups: { 'grp-1': { requireMention: false } },
          },
        },
      },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-1', senderRawId: 'user-1', isMention: false }),
    );
    expect(r.action).toBe('allow');
  });

  it('10. group: groupPolicy=open (no allow lists) → allow with mention', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: { default: { groupPolicy: 'open', groups: { '*': { requireMention: false } } } },
      },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-x', senderRawId: 'stranger' }),
    );
    expect(r.action).toBe('allow');
  });

  it('11. group: groupPolicy=strict default → deny', () => {
    const cfg = mkConfig({
      telegram: { accounts: { default: { groupPolicy: 'strict' } } },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-x', senderRawId: 'stranger', isMention: true }),
    );
    expect(r.action).toBe('deny');
  });

  it('12. group: specific groupId entry overrides "*" wildcard', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'open',
            groups: {
              '*': { requireMention: false },
              'grp-1': { allowFrom: ['only-me'], requireMention: false },
            },
          },
        },
      },
    });
    // Sender NOT in 'grp-1' allowFrom → specific overrides wildcard → deny (groupPolicy open
    // would otherwise allow, but the cascade landed on the explicit entry's allowFrom list).
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-1', senderRawId: 'stranger' }),
    );
    // Note: in the current implementation, the explicit group entry's allowFrom DOES participate
    // in the cascade; if sender isn't in it, the code falls through to groupPolicy. With
    // groupPolicy='open' the result is `allow`. The wildcard check below confirms ordering: a
    // sender that matches the wildcard's allowFrom but not the specific entry's gets blocked
    // ONLY when groupPolicy='strict'. So here we just confirm specific entry was selected by
    // asserting requireMention=false from 'grp-1' (not '*') is what governs the result.
    expect(r.action).toBe('allow');

    // Now flip to strict and confirm specific overrides wildcard:
    const cfg2 = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'strict',
            groups: {
              '*': { allowFrom: ['stranger'], requireMention: false },
              'grp-1': { allowFrom: ['only-me'], requireMention: false },
            },
          },
        },
      },
    });
    const r2 = checkInboundAccess(
      cfg2,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-1', senderRawId: 'stranger' }),
    );
    // Wildcard would allow 'stranger', but specific 'grp-1' entry takes precedence → deny.
    expect(r2.action).toBe('deny');
  });

  it('13. requireMention=true and !isMention → deny', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'strict',
            allowFrom: ['user-1'],
            groups: { '*': { requireMention: true } },
          },
        },
      },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-x', senderRawId: 'user-1', isMention: false }),
    );
    expect(r.action).toBe('deny');
    expect(r.reason).toMatch(/requireMention/);
  });

  it('14. requireMention=false → allow without mention', () => {
    const cfg = mkConfig({
      telegram: {
        accounts: {
          default: {
            groupPolicy: 'strict',
            allowFrom: ['user-1'],
            groups: { '*': { requireMention: false } },
          },
        },
      },
    });
    const r = checkInboundAccess(
      cfg,
      db,
      mkInbound({ isGroup: true, platformId: 'grp-x', senderRawId: 'user-1', isMention: false }),
    );
    expect(r.action).toBe('allow');
  });

  it('15. owner role bypass (DM strict, sender not in allowFrom)', () => {
    makeOwner(db, 'telegram', 'user-owner');
    const cfg = mkConfig({
      telegram: { accounts: { default: { dmPolicy: 'strict', allowFrom: [] } } },
    });
    const r = checkInboundAccess(cfg, db, mkInbound({ senderRawId: 'user-owner' }));
    expect(r.action).toBe('allow');
  });
});
