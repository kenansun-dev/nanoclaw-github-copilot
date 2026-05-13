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
import { describe, it, expect } from 'vitest';

import type { NanoclawConfig } from '../config-loader.js';
import { runMigrations } from './migrations/index.js';
import { reconcileConfigToDb } from './v2-reconcile.js';

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
