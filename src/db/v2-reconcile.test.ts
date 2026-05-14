/**
 * Tests for `reconcileConfigToDb` — idempotent transactional sync from
 * declared nanoclaw config to v2 runtime tables (agent_groups, users,
 * user_roles).
 *
 * Covers each step independently per the proposal §"Reconcile pipeline":
 *   1. agents.list[] → agent_groups (insert / update / archive)
 *   2. allowFrom lists → users (INSERT OR IGNORE)
 *   3. commands.ownerAllowFrom → user_roles (role='owner', sync set)
 *
 * NOT covered (intentionally): messaging_groups population, which is
 * lazy on first inbound (router-switch commit).
 */
import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import type { NanoclawConfig } from '../config-loader.js';
import { log } from '../log.js';
import { runMigrations } from './migrations/index.js';
import { reconcileConfigToDb, __resetDeprecationWarningsForTests } from './v2-reconcile.js';

function open(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeConfig(over: Partial<NanoclawConfig> = {}): NanoclawConfig {
  // Minimal NanoclawConfig stub. The reconcile function only reads
  // `agents.list`, `channels.*.accounts.*.{allowFrom,groupAllowFrom,
  // groups.*.allowFrom}` and `commands.ownerAllowFrom`, so everything
  // else can stay empty.
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
    channels: {
      discord: { enabled: false },
      telegram: { enabled: false },
      teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
    },
    mcp: { servers: {} },
    skills: { directories: [], disabled: [] },
    sandbox: {
      runtime: 'docker',
      image: 'x',
      timeout: 1,
      maxOutputSize: 1,
      maxConcurrent: 1,
    },
    chats: {},
    pairing: { mode: 'disabled' },
    credentialProxy: { port: 3001 },
    logLevel: 'info',
    timezone: 'UTC',
    ...over,
  } as NanoclawConfig;
}

describe('reconcileConfigToDb — agent_groups', () => {
  it('inserts agents.list[] into agent_groups on first run', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [
          { id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' },
          { id: 'coder', model: 'm', name: 'Coder', triggerWord: '@c', hasOwnNumber: false, mode: 'sandbox' },
        ],
      },
    });
    const summary = reconcileConfigToDb(cfg, db);
    expect(summary.agentGroups.inserted.sort()).toEqual(['coder', 'main']);
    const rows = db.prepare('SELECT id, name FROM agent_groups ORDER BY id').all() as Array<{
      id: string;
      name: string;
    }>;
    expect(rows).toEqual([
      { id: 'coder', name: 'Coder' },
      { id: 'main', name: 'Main' },
    ]);
  });

  it('is idempotent — second run inserts nothing new', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
    });
    reconcileConfigToDb(cfg, db);
    const second = reconcileConfigToDb(cfg, db);
    expect(second.agentGroups.inserted).toEqual([]);
    expect(second.agentGroups.updated).toEqual([]);
    expect(second.agentGroups.archived).toEqual([]);
  });

  it('updates name/provider when config diverges', () => {
    const db = open();
    const cfg1 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
    });
    reconcileConfigToDb(cfg1, db);
    const cfg2 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [
          {
            id: 'main',
            model: 'm',
            name: 'Renamed',
            triggerWord: '@m',
            hasOwnNumber: false,
            mode: 'host',
            provider: 'github-copilot',
          },
        ],
      },
    });
    const s = reconcileConfigToDb(cfg2, db);
    expect(s.agentGroups.updated).toEqual(['main']);
    const row = db.prepare('SELECT name, agent_provider FROM agent_groups WHERE id = ?').get('main') as {
      name: string;
      agent_provider: string;
    };
    expect(row.name).toBe('Renamed');
    expect(row.agent_provider).toBe('github-copilot');
  });

  it('archives (does not delete) agents removed from config — protects FK refs', () => {
    const db = open();
    const cfg1 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [
          { id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' },
          { id: 'old', model: 'm', name: 'Old', triggerWord: '@o', hasOwnNumber: false, mode: 'host' },
        ],
      },
    });
    reconcileConfigToDb(cfg1, db);
    const cfg2 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
    });
    const s = reconcileConfigToDb(cfg2, db);
    expect(s.agentGroups.archived).toEqual(['old']);
    const row = db.prepare('SELECT agent_provider, archived_at FROM agent_groups WHERE id = ?').get('old') as {
      agent_provider: string | null;
      archived_at: string | null;
    };
    // archived_at column carries the archival timestamp; agent_provider
    // is no longer used as a sentinel (fixup #49 step 9.5).
    expect(row.archived_at).not.toBeNull();
    expect(row.agent_provider).not.toBe('archived');
    // Row preserved (not deleted)
    expect(db.prepare('SELECT COUNT(*) AS c FROM agent_groups').get()).toEqual({ c: 2 });
  });

  it('unarchives a previously archived agent when it reappears in config', () => {
    const db = open();
    const cfg1 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [
          { id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' },
          { id: 'old', model: 'm', name: 'Old', triggerWord: '@o', hasOwnNumber: false, mode: 'host' },
        ],
      },
    });
    reconcileConfigToDb(cfg1, db);
    // Drop 'old' → archived.
    const cfg2 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
    });
    reconcileConfigToDb(cfg2, db);
    const archivedRow = db.prepare('SELECT archived_at FROM agent_groups WHERE id = ?').get('old') as {
      archived_at: string | null;
    };
    expect(archivedRow.archived_at).not.toBeNull();
    // Re-declare 'old' → archived_at should be cleared.
    const cfg3 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [
          { id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' },
          { id: 'old', model: 'm', name: 'Old', triggerWord: '@o', hasOwnNumber: false, mode: 'host' },
        ],
      },
    });
    reconcileConfigToDb(cfg3, db);
    const unarchivedRow = db.prepare('SELECT archived_at FROM agent_groups WHERE id = ?').get('old') as {
      archived_at: string | null;
    };
    expect(unarchivedRow.archived_at).toBeNull();
  });
});

describe('reconcileConfigToDb — users', () => {
  it('upserts users from every allowFrom list across accounts', () => {
    const db = open();
    const cfg = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: {
          enabled: true,
          accounts: {
            personal: {
              allowFrom: ['8731'],
              groupAllowFrom: ['9999'],
              groups: { '-1001': { allowFrom: ['7777'] } },
            },
            work: { allowFrom: ['8731', '5555'] }, // 8731 dedup across accounts
          },
        },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      },
    });
    const s = reconcileConfigToDb(cfg, db);
    const ids = db.prepare('SELECT id FROM users ORDER BY id').all() as Array<{ id: string }>;
    expect(ids.map((r) => r.id)).toEqual(['telegram:5555', 'telegram:7777', 'telegram:8731', 'telegram:9999']);
    expect(s.users.inserted.length).toBe(4);
  });

  it('INSERT OR IGNORE: rerun does not overwrite existing rows', () => {
    const db = open();
    const cfg = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: { enabled: true, accounts: { personal: { allowFrom: ['8731'] } } },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      },
    });
    reconcileConfigToDb(cfg, db);
    // Mutate display_name post-insert to detect an unwanted overwrite
    db.prepare(`UPDATE users SET display_name = 'kenan' WHERE id = ?`).run('telegram:8731');
    const second = reconcileConfigToDb(cfg, db);
    expect(second.users.inserted).toEqual([]);
    const row = db.prepare('SELECT display_name FROM users WHERE id = ?').get('telegram:8731') as {
      display_name: string;
    };
    expect(row.display_name).toBe('kenan');
  });

  it('owners in ownerAllowFrom are upserted into users even if absent from allowFrom', () => {
    const db = open();
    const cfg = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: { enabled: false },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      },
    });
    (cfg as unknown as { commands: { ownerAllowFrom: string[] } }).commands = {
      ownerAllowFrom: ['telegram:8731'],
    };
    reconcileConfigToDb(cfg, db);
    const row = db.prepare('SELECT id, kind FROM users WHERE id = ?').get('telegram:8731');
    expect(row).toEqual({ id: 'telegram:8731', kind: 'telegram' });
  });
});

describe('reconcileConfigToDb — user_roles (owner sync)', () => {
  it('inserts owner role from commands.ownerAllowFrom (global, agent_group_id=NULL)', () => {
    const db = open();
    const cfg = makeConfig();
    (cfg as unknown as { commands: { ownerAllowFrom: string[] } }).commands = {
      ownerAllowFrom: ['telegram:8731', 'teams:29:abc'],
    };
    const s = reconcileConfigToDb(cfg, db);
    expect(s.userRoles.inserted.sort()).toEqual(['teams:29:abc', 'telegram:8731']);
    const rows = db
      .prepare(`SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL ORDER BY user_id`)
      .all() as Array<{ user_id: string }>;
    expect(rows.map((r) => r.user_id)).toEqual(['teams:29:abc', 'telegram:8731']);
  });

  it('removes owner role when sender drops out of ownerAllowFrom', () => {
    const db = open();
    const cfg1 = makeConfig();
    (cfg1 as unknown as { commands: { ownerAllowFrom: string[] } }).commands = {
      ownerAllowFrom: ['telegram:8731'],
    };
    reconcileConfigToDb(cfg1, db);
    const cfg2 = makeConfig();
    (cfg2 as unknown as { commands: { ownerAllowFrom: string[] } }).commands = { ownerAllowFrom: [] };
    const s = reconcileConfigToDb(cfg2, db);
    expect(s.userRoles.deleted).toEqual(['telegram:8731']);
    expect(db.prepare(`SELECT COUNT(*) AS c FROM user_roles`).get()).toEqual({ c: 0 });
    // user row preserved — only role removed
    expect(db.prepare(`SELECT COUNT(*) AS c FROM users WHERE id = 'telegram:8731'`).get()).toEqual({ c: 1 });
  });

  it('is fully idempotent across all three steps', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
      channels: {
        discord: { enabled: false },
        telegram: { enabled: true, accounts: { personal: { allowFrom: ['8731'] } } },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      },
    });
    (cfg as unknown as { commands: { ownerAllowFrom: string[] } }).commands = {
      ownerAllowFrom: ['telegram:8731'],
    };
    reconcileConfigToDb(cfg, db);
    const second = reconcileConfigToDb(cfg, db);
    expect(second.agentGroups.inserted).toEqual([]);
    expect(second.users.inserted).toEqual([]);
    expect(second.userRoles.inserted).toEqual([]);
    expect(second.userRoles.deleted).toEqual([]);
  });

  it('rolls back the entire reconcile on transaction failure', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
    });
    reconcileConfigToDb(cfg, db);
    // Inject a folder conflict: agent_groups.folder is UNIQUE. Create a
    // new agent whose id != existing but whose folder ('main') collides
    // with the existing row's folder. INSERT throws inside the tx →
    // archived update from the same pass must roll back too.
    const cfg2 = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        // Drop 'main' (would archive), add 'collide' whose folder='collide'
        // — no collision actually. To force a real failure, manually
        // tamper: insert a pre-existing row with folder='collide' so the
        // reconcile INSERT collides.
        list: [
          {
            id: 'collide',
            model: 'm',
            name: 'X',
            triggerWord: '@x',
            hasOwnNumber: false,
            mode: 'host',
          },
        ],
      },
    });
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES ('squatter', 'Squatter', 'collide', NULL, ?)`,
    ).run(new Date().toISOString());

    expect(() => reconcileConfigToDb(cfg2, db)).toThrow();
    // 'main' should NOT have been archived because the tx rolled back
    const mainRow = db.prepare('SELECT agent_provider FROM agent_groups WHERE id = ?').get('main') as {
      agent_provider: string | null;
    };
    expect(mainRow.agent_provider).toBeNull();
  });
});

describe('reconcileConfigToDb — agent_group_members projection (PR-D)', () => {
  it('projects allowFrom users into agent_group_members on every live agent', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: {
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [
          { id: 'a1', name: 'A1' },
          { id: 'a2', name: 'A2' },
        ],
      },
      channels: {
        telegram: {
          enabled: false,
          accounts: { default: { allowFrom: ['user-X', 'user-Y'] } },
        },
      } as NanoclawConfig['channels'],
    });
    const summary = reconcileConfigToDb(cfg, db);
    // 2 users × 2 agent_groups = 4 inserts
    expect(summary.agentGroupMembers.inserted).toBe(4);
    const rows = db
      .prepare(`SELECT user_id, agent_group_id FROM agent_group_members ORDER BY user_id, agent_group_id`)
      .all() as Array<{ user_id: string; agent_group_id: string }>;
    expect(rows).toEqual([
      { user_id: 'telegram:user-X', agent_group_id: 'a1' },
      { user_id: 'telegram:user-X', agent_group_id: 'a2' },
      { user_id: 'telegram:user-Y', agent_group_id: 'a1' },
      { user_id: 'telegram:user-Y', agent_group_id: 'a2' },
    ]);
  });

  it('skips owners (implicit member via user_roles)', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: {
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [{ id: 'a1', name: 'A1' }],
      },
      channels: {
        telegram: {
          enabled: false,
          accounts: { default: { allowFrom: ['user-X'] } },
        },
      } as NanoclawConfig['channels'],
      commands: { ownerAllowFrom: ['telegram:user-X'] },
    } as Partial<NanoclawConfig>);
    const summary = reconcileConfigToDb(cfg, db);
    // user-X is owner — no member row
    expect(summary.agentGroupMembers.inserted).toBe(0);
    const memberRows = db.prepare(`SELECT count(*) as n FROM agent_group_members`).get() as { n: number };
    expect(memberRows.n).toBe(0);
    const ownerRows = db.prepare(`SELECT count(*) as n FROM user_roles WHERE role='owner'`).get() as { n: number };
    expect(ownerRows.n).toBe(1);
  });

  it('idempotent: re-run with same config inserts 0 new rows', () => {
    const db = open();
    const cfg = makeConfig({
      agents: {
        defaults: {
          model: 'm',
          name: 'D',
          triggerWord: '@d',
          hasOwnNumber: false,
          mode: 'host',
        },
        list: [{ id: 'a1', name: 'A1' }],
      },
      channels: {
        telegram: {
          enabled: false,
          accounts: { default: { allowFrom: ['user-X'] } },
        },
      } as NanoclawConfig['channels'],
    });
    reconcileConfigToDb(cfg, db);
    const second = reconcileConfigToDb(cfg, db);
    expect(second.agentGroupMembers.inserted).toBe(0);
  });
});

describe('reconcileConfigToDb — messaging_group_agents engage_mode projection (PR-D step 5)', () => {
  // Helper to seed an mg + mga so the projection has something to update.
  function seedGroup(
    db: Database.Database,
    opts: {
      mgId: string;
      channelType: string;
      peerId: string;
      isGroup: 0 | 1;
      agentId: string;
      mgaId: string;
      engageMode?: string;
      engagePattern?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    db.prepare(
      `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, NULL, ?)`,
    ).run(opts.agentId, opts.agentId, opts.agentId, now);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, created_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    ).run(opts.mgId, opts.channelType, opts.peerId, opts.isGroup, now);
    db.prepare(
      `INSERT INTO messaging_group_agents
         (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
          sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, ?, ?, 'all', 'drop', 'shared', 0, ?)`,
    ).run(opts.mgaId, opts.mgId, opts.agentId, opts.engageMode ?? 'pattern', opts.engagePattern ?? '.', now);
  }

  it('requireMention=false → engage_mode=pattern, engage_pattern=.', () => {
    const db = open();
    seedGroup(db, {
      mgId: 'mg1',
      channelType: 'telegram',
      peerId: '-1001',
      isGroup: 1,
      agentId: 'a1',
      mgaId: 'mga1',
      engageMode: 'mention-sticky',
      engagePattern: null,
    });
    const cfg = makeConfig({
      agents: { defaults: makeConfig().agents.defaults, list: [{ id: 'a1', name: 'A1' }] },
      channels: {
        telegram: {
          enabled: false,
          accounts: { default: { groups: { '-1001': { requireMention: false } } } },
        },
      } as NanoclawConfig['channels'],
    });
    const s = reconcileConfigToDb(cfg, db);
    expect(s.messagingGroupAgents.updated).toBe(1);
    const row = db
      .prepare(`SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = ?`)
      .get('mga1') as { engage_mode: string; engage_pattern: string | null };
    expect(row.engage_mode).toBe('pattern');
    expect(row.engage_pattern).toBe('.');
  });

  it('requireMention=true → engage_mode=mention-sticky, engage_pattern=NULL', () => {
    const db = open();
    seedGroup(db, {
      mgId: 'mg2',
      channelType: 'telegram',
      peerId: '-1002',
      isGroup: 1,
      agentId: 'a1',
      mgaId: 'mga2',
      engageMode: 'pattern',
      engagePattern: '.',
    });
    const cfg = makeConfig({
      agents: { defaults: makeConfig().agents.defaults, list: [{ id: 'a1', name: 'A1' }] },
      channels: {
        telegram: {
          enabled: false,
          accounts: { default: { groups: { '-1002': { requireMention: true } } } },
        },
      } as NanoclawConfig['channels'],
    });
    const s = reconcileConfigToDb(cfg, db);
    expect(s.messagingGroupAgents.updated).toBe(1);
    const row = db
      .prepare(`SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = ?`)
      .get('mga2') as { engage_mode: string; engage_pattern: string | null };
    expect(row.engage_mode).toBe('mention-sticky');
    expect(row.engage_pattern).toBeNull();
  });

  it('requireMention unset defaults to true (mention-sticky)', () => {
    const db = open();
    seedGroup(db, {
      mgId: 'mg3',
      channelType: 'telegram',
      peerId: '-1003',
      isGroup: 1,
      agentId: 'a1',
      mgaId: 'mga3',
      engageMode: 'pattern',
      engagePattern: '.',
    });
    const cfg = makeConfig({
      agents: { defaults: makeConfig().agents.defaults, list: [{ id: 'a1', name: 'A1' }] },
      channels: {
        telegram: {
          enabled: false,
          accounts: { default: { groups: { '-1003': {} } } },
        },
      } as NanoclawConfig['channels'],
    });
    const s = reconcileConfigToDb(cfg, db);
    expect(s.messagingGroupAgents.updated).toBe(1);
    const row = db
      .prepare(`SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = ?`)
      .get('mga3') as { engage_mode: string; engage_pattern: string | null };
    expect(row.engage_mode).toBe('mention-sticky');
    expect(row.engage_pattern).toBeNull();
  });

  it('does not touch DM messaging_groups (is_group=0) — router default stays', () => {
    const db = open();
    seedGroup(db, {
      mgId: 'mg-dm',
      channelType: 'telegram',
      peerId: '8731',
      isGroup: 0, // DM
      agentId: 'a1',
      mgaId: 'mga-dm',
      engageMode: 'pattern',
      engagePattern: '.',
    });
    const cfg = makeConfig({
      agents: { defaults: makeConfig().agents.defaults, list: [{ id: 'a1', name: 'A1' }] },
      channels: {
        telegram: {
          enabled: false,
          // requireMention=false on a peer that happens to also be a DM:
          // since is_group=0, the projection MUST NOT match.
          accounts: { default: { groups: { '8731': { requireMention: false } } } },
        },
      } as NanoclawConfig['channels'],
    });
    const s = reconcileConfigToDb(cfg, db);
    expect(s.messagingGroupAgents.updated).toBe(0);
    const row = db
      .prepare(`SELECT engage_mode, engage_pattern FROM messaging_group_agents WHERE id = ?`)
      .get('mga-dm') as { engage_mode: string; engage_pattern: string | null };
    expect(row.engage_mode).toBe('pattern');
    expect(row.engage_pattern).toBe('.');
  });
});

describe('reconcileConfigToDb — channels.<type>.roleBindings (RBAC step 1+2)', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('writes user_roles(role=owner, agent_group_id IS NULL) from channels.telegram.roleBindings', () => {
    const db = open();
    const cfg = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: {
          enabled: true,
          roleBindings: { '8731187021': 'owner' },
        },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      } as NanoclawConfig['channels'],
    });
    const s = reconcileConfigToDb(cfg, db);
    expect(s.userRoles.inserted).toContain('telegram:8731187021');
    const row = db
      .prepare(
        `SELECT user_id, role, agent_group_id FROM user_roles
          WHERE user_id = 'telegram:8731187021' AND role = 'owner'`,
      )
      .get() as { user_id: string; role: string; agent_group_id: null } | undefined;
    expect(row).toBeDefined();
    expect(row!.agent_group_id).toBeNull();
    // user row also bootstrapped
    const u = db.prepare(`SELECT id, kind FROM users WHERE id = ?`).get('telegram:8731187021');
    expect(u).toEqual({ id: 'telegram:8731187021', kind: 'telegram' });
  });

  it('writes admin role globally (agent_group_id IS NULL) from roleBindings', () => {
    const db = open();
    const cfg = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: {
          enabled: true,
          roleBindings: { '8731': 'owner', '4242': 'admin' },
        },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      } as NanoclawConfig['channels'],
    });
    reconcileConfigToDb(cfg, db);
    const rows = db
      .prepare(
        `SELECT user_id, role FROM user_roles
          WHERE agent_group_id IS NULL ORDER BY user_id`,
      )
      .all() as Array<{ user_id: string; role: string }>;
    expect(rows).toEqual([
      { user_id: 'telegram:4242', role: 'admin' },
      { user_id: 'telegram:8731', role: 'owner' },
    ]);
  });

  it('full overwrite: dropping a roleBinding removes the role row', () => {
    const db = open();
    const cfg1 = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: { enabled: true, roleBindings: { '8731': 'owner' } },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      } as NanoclawConfig['channels'],
    });
    reconcileConfigToDb(cfg1, db);
    const cfg2 = makeConfig({
      channels: {
        discord: { enabled: false },
        telegram: { enabled: true },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
      } as NanoclawConfig['channels'],
    });
    const s = reconcileConfigToDb(cfg2, db);
    expect(s.userRoles.deleted).toContain('telegram:8731');
    const cnt = db.prepare(`SELECT COUNT(*) AS c FROM user_roles`).get() as { c: number };
    expect(cnt.c).toBe(0);
  });
});

describe('reconcileConfigToDb — deprecated commands.ownerAllowFrom auto-merge', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('auto-merges commands.ownerAllowFrom into roleBindings + writes owner row + warns once', () => {
    const warnSpy: string[] = [];
    const origWarn = log.warn;
    log.warn = (msg: string) => {
      warnSpy.push(msg);
    };
    try {
      const db = open();
      const cfg = makeConfig();
      (cfg as unknown as { commands: { ownerAllowFrom: string[] } }).commands = {
        ownerAllowFrom: ['telegram:8731187021'],
      };
      reconcileConfigToDb(cfg, db);
      // (a) deprecation warn fired exactly once
      expect(warnSpy.filter((m) => m.includes('commands.ownerAllowFrom is deprecated')).length).toBe(1);
      // (b) owner row written global
      const row = db
        .prepare(
          `SELECT user_id FROM user_roles
            WHERE user_id = 'telegram:8731187021' AND role = 'owner' AND agent_group_id IS NULL`,
        )
        .get();
      expect(row).toBeDefined();
      // (c) live config now carries roleBindings entry
      expect((cfg.channels.telegram as unknown as { roleBindings?: Record<string, string> }).roleBindings).toEqual({
        '8731187021': 'owner',
      });
    } finally {
      log.warn = origWarn;
    }
  });
});

describe('reconcileConfigToDb — deprecated accounts.*.groupAllowFrom auto-merge', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('merges groupAllowFrom into allowFrom + drops the field + warns once', () => {
    const warnSpy: string[] = [];
    const origWarn = log.warn;
    log.warn = (msg: string) => {
      warnSpy.push(msg);
    };
    try {
      const db = open();
      const cfg = makeConfig({
        channels: {
          discord: { enabled: false },
          telegram: {
            enabled: true,
            accounts: {
              default: { allowFrom: ['8731'], groupAllowFrom: ['7777'] },
            },
          },
          teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
        } as NanoclawConfig['channels'],
      });
      reconcileConfigToDb(cfg, db);
      expect(warnSpy.filter((m) => m.includes('groupAllowFrom is deprecated')).length).toBe(1);
      const acc = (
        cfg.channels.telegram as unknown as {
          accounts: { default: { allowFrom: string[]; groupAllowFrom?: string[] } };
        }
      ).accounts.default;
      expect(acc.allowFrom?.sort()).toEqual(['7777', '8731']);
      expect(acc.groupAllowFrom).toBeUndefined();
      // user row created for the merged id
      const u = db.prepare(`SELECT id FROM users WHERE id = ?`).get('telegram:7777');
      expect(u).toEqual({ id: 'telegram:7777' });
    } finally {
      log.warn = origWarn;
    }
  });
});

// Regression: deepMerge in loadConfig keeps DEFAULTS.channels by reference
// when user config omits `channels`. Pre-cutover bug let autoMerge writes
// leak into the DEFAULTS singleton and bleed across boots / test cases
// (was caught by v2-boot.test.ts "auto-migrates legacy chats[]" failing
// with a stale '99' → 'owner' from a sibling test). Pin behavior:
// reconcile must not pre-populate roleBindings on a config that never
// declared the deprecated source field.
describe('reconcileConfigToDb — DEFAULTS leak regression', () => {
  beforeEach(() => __resetDeprecationWarningsForTests());

  it('does not leak roleBindings writes across separate config objects', () => {
    const db = open();
    // First config: no `channels` key at all + legacy commands.ownerAllowFrom.
    const cfg1 = {
      configVersion: 2,
      agents: {
        defaults: {
          provider: 'p', model: 'm', name: 'D', triggerWord: '@d',
          hasOwnNumber: false, mode: 'host' as const,
        },
        list: [{ id: 'main' }],
      },
      commands: { ownerAllowFrom: ['telegram:42'] },
    } as unknown as NanoclawConfig;
    reconcileConfigToDb(cfg1, db);

    // The autoMerge wrote a fresh `channels` map onto cfg1.
    expect(
      (cfg1 as unknown as { channels?: Record<string, { roleBindings?: Record<string, string> }> })
        .channels?.telegram?.roleBindings,
    ).toEqual({ '42': 'owner' });

    // Second, completely fresh config: also omits `channels`, has no
    // commands.ownerAllowFrom. If reconcile had mutated any shared
    // singleton (e.g. DEFAULTS.channels), this config would arrive with
    // a phantom roleBindings entry.
    const cfg2 = {
      configVersion: 2,
      agents: {
        defaults: {
          provider: 'p', model: 'm', name: 'D', triggerWord: '@d',
          hasOwnNumber: false, mode: 'host' as const,
        },
        list: [{ id: 'main' }],
      },
    } as unknown as NanoclawConfig;
    reconcileConfigToDb(cfg2, db);

    // No channels key was added — nothing to merge into.
    expect((cfg2 as unknown as { channels?: unknown }).channels).toBeUndefined();
  });
});
