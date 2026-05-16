/**
 * Tests for `migrateChatsToV2` (src/db/v2-migrate-chats.ts).
 *
 * Covers:
 *   - DM with isMain → allowFrom + ownerAllowFrom + users + user_roles
 *   - DM without isMain → allowFrom only
 *   - group → groups[<id>].requireMention=true (legacy trigger-only preserved)
 *   - idempotency (re-run with no config.chats and no legacy rows = no-op)
 *   - mixed config + DB legacy rows in a single call
 *   - snapshot file is created
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { NanoclawConfig } from '../config-loader.js';
import { runMigrations } from './migrations/index.js';
import { migrateChatsToV2 } from './v2-migrate-chats.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-migrate-chats-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function open(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

function makeConfig(over: Partial<NanoclawConfig> = {}): NanoclawConfig {
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

describe('migrateChatsToV2 — config side', () => {
  it('DM with isMain → allowFrom + ownerAllowFrom + users + user_roles', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {
        'telegram:8731': { name: 'Owner DM', isMain: true },
      },
    });

    const summary = migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });

    expect(summary.dms).toEqual(['telegram:8731']);
    expect(summary.ownersBootstrapped).toEqual(['telegram:8731']);
    expect(cfg.chats).toBeUndefined();
    expect(cfg.channels.telegram.accounts!.default.allowFrom).toEqual(['8731']);
    // v2 RBAC cutover: isMain → channels.<type>.roleBindings instead of
    // commands.ownerAllowFrom.
    expect((cfg.channels.telegram as unknown as { roleBindings: Record<string, string> }).roleBindings).toEqual({
      '8731': 'owner',
    });

    const user = db.prepare(`SELECT id, kind FROM users WHERE id = ?`).get('telegram:8731') as {
      id: string;
      kind: string;
    };
    expect(user).toEqual({ id: 'telegram:8731', kind: 'telegram' });
    const role = db.prepare(`SELECT role, agent_group_id FROM user_roles WHERE user_id = ?`).get('telegram:8731') as {
      role: string;
      agent_group_id: null;
    };
    expect(role.role).toBe('owner');
    expect(role.agent_group_id).toBeNull();
  });

  it('DM without isMain → allowFrom only, no owner role inserted', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {
        'telegram:42': { name: 'Friend DM' },
      },
    });
    const summary = migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });

    expect(summary.dms).toEqual(['telegram:42']);
    expect(summary.ownersBootstrapped).toEqual([]);
    expect(cfg.channels.telegram.accounts!.default.allowFrom).toEqual(['42']);
    expect(
      (cfg.channels.telegram as unknown as { roleBindings?: Record<string, string> }).roleBindings,
    ).toBeUndefined();
    const role = db.prepare(`SELECT COUNT(*) AS c FROM user_roles`).get() as { c: number };
    expect(role.c).toBe(0);
  });

  it('group → groups[<id>].requireMention=true (preserves legacy trigger-only default)', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {
        'telegram:-1001crew': { name: 'Crew', isMain: true },
      },
    });
    const summary = migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });

    expect(summary.groups).toEqual(['telegram:-1001crew']);
    expect(summary.dms).toEqual([]);
    const groups = cfg.channels.telegram.accounts!.default.groups!;
    expect(groups['-1001crew']).toEqual({ requireMention: true });
    // isMain on a group does NOT promote to owner (owners are DM-rooted)
    expect(
      (cfg.channels.telegram as unknown as { roleBindings?: Record<string, string> }).roleBindings,
    ).toBeUndefined();
  });

  it('respects authoritative isGroupByJid override (Telegram negative-id heuristic is fallback)', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {
        // Positive id but authoritative says "group" — must respect map.
        'telegram:777': { name: 'odd group' },
      },
    });
    const summary = migrateChatsToV2(cfg, db, {
      skipSaveConfig: true,
      skipSnapshot: true,
      isGroupByJid: new Map([['telegram:777', true]]),
    });
    expect(summary.groups).toEqual(['telegram:777']);
    expect(summary.dms).toEqual([]);
  });

  it('idempotent: re-run with no config.chats and no legacy DB rows is a no-op', () => {
    const db = open();
    const cfg = makeConfig({});
    const summary = migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(summary.noop).toBe(true);
    expect(summary.dms).toEqual([]);
    expect(summary.groups).toEqual([]);
    expect(summary.legacyChatsMigrated).toBe(0);
    expect(summary.legacyRegisteredGroupsMigrated).toBe(0);
  });

  it('snapshot file is created when configPath exists', () => {
    const db = open();
    const cfg = makeConfig({
      chats: { 'telegram:1': { name: 'x' } },
    });
    const configPath = path.join(tmpDir, 'nanoclaw.json');
    fs.writeFileSync(configPath, JSON.stringify({ original: true }), 'utf-8');

    const summary = migrateChatsToV2(cfg, db, { configPath, skipSaveConfig: true });
    expect(summary.snapshotPath).toBe(`${configPath}.pre-v2.bak`);
    expect(fs.existsSync(summary.snapshotPath!)).toBe(true);
    expect(JSON.parse(fs.readFileSync(summary.snapshotPath!, 'utf-8'))).toEqual({ original: true });
  });
});

describe('migrateChatsToV2 — DB side (legacy tables → v2)', () => {
  function seedLegacyTables(db: Database.Database, opts: { chats?: boolean; rg?: boolean }): void {
    if (opts.chats) {
      db.exec(`CREATE TABLE chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT,
        channel TEXT,
        is_group INTEGER DEFAULT 0
      )`);
      db.prepare(`INSERT INTO chats (jid, name, channel, is_group) VALUES (?, ?, ?, ?)`).run(
        'telegram:42',
        'Friend',
        'telegram',
        0,
      );
      db.prepare(`INSERT INTO chats (jid, name, channel, is_group) VALUES (?, ?, ?, ?)`).run(
        'telegram:-100crew',
        'Crew',
        'telegram',
        1,
      );
      db.prepare(`INSERT INTO chats (jid, name) VALUES (?, ?)`).run('__group_sync__', '__group_sync__');
    }
    if (opts.rg) {
      db.exec(`CREATE TABLE registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1
      )`);
      db.prepare(
        `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('telegram:-100crew', 'Crew', 'crew-main', '@bot', new Date().toISOString());
    }
  }

  it('migrates legacy chats rows → messaging_groups (skipping sentinel rows)', () => {
    const db = open();
    seedLegacyTables(db, { chats: true });
    const summary = migrateChatsToV2(makeConfig({}), db, { skipSaveConfig: true, skipSnapshot: true });
    expect(summary.legacyChatsMigrated).toBe(2);
    const mgs = db
      .prepare(`SELECT platform_id, channel_type, account_key, is_group FROM messaging_groups ORDER BY platform_id`)
      .all() as Array<{ platform_id: string; channel_type: string; account_key: string; is_group: number }>;
    expect(mgs).toEqual([
      { platform_id: '-100crew', channel_type: 'telegram', account_key: 'default', is_group: 1 },
      { platform_id: '42', channel_type: 'telegram', account_key: 'default', is_group: 0 },
    ]);
  });

  it('migrates legacy registered_groups rows → agent_groups', () => {
    const db = open();
    seedLegacyTables(db, { rg: true });
    const summary = migrateChatsToV2(makeConfig({}), db, { skipSaveConfig: true, skipSnapshot: true });
    expect(summary.legacyRegisteredGroupsMigrated).toBe(1);
    const ags = db.prepare(`SELECT name, folder FROM agent_groups`).all() as Array<{
      name: string;
      folder: string;
    }>;
    expect(ags).toEqual([{ name: 'Crew', folder: 'crew-main' }]);
  });

  it('mixed config.chats + legacy DB rows in one call', () => {
    const db = open();
    seedLegacyTables(db, { chats: true, rg: true });
    const cfg = makeConfig({
      chats: { 'telegram:8731': { name: 'Owner', isMain: true } },
    });
    const summary = migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(summary.dms).toEqual(['telegram:8731']);
    expect(summary.legacyChatsMigrated).toBe(2);
    expect(summary.legacyRegisteredGroupsMigrated).toBe(1);
    expect(summary.noop).toBe(false);
  });

  it('legacyDb opt: reads legacy tables from a separate handle (v2-boot wiring)', () => {
    // Regression for 2026-05-16 deploy bug: in production v2.db never
    // carries `chats`/`registered_groups`; those live on messages.db.
    // v2-boot opens messages.db read-only and passes via opts.legacyDb.
    const v2db = open();
    const legacyDb = new Database(':memory:');
    seedLegacyTables(legacyDb, { chats: true, rg: true });
    const summary = migrateChatsToV2(makeConfig({}), v2db, {
      skipSaveConfig: true,
      skipSnapshot: true,
      legacyDb,
    });
    expect(summary.legacyChatsMigrated).toBe(2);
    expect(summary.legacyRegisteredGroupsMigrated).toBe(1);
    const mgs = v2db.prepare(`SELECT COUNT(*) as n FROM messaging_groups`).get() as { n: number };
    expect(mgs.n).toBe(2);
    const ags = v2db.prepare(`SELECT COUNT(*) as n FROM agent_groups`).get() as { n: number };
    expect(ags.n).toBe(1);
    expect(
      legacyDb.prepare(`SELECT name FROM sqlite_master WHERE name='messaging_groups'`).get(),
    ).toBeUndefined();
  });

  it('idempotent: second run with same inputs is a no-op (INSERT OR IGNORE)', () => {
    const db = open();
    seedLegacyTables(db, { chats: true, rg: true });
    const cfg1 = makeConfig({ chats: { 'telegram:1': { name: 'a' } } });
    migrateChatsToV2(cfg1, db, { skipSaveConfig: true, skipSnapshot: true });

    const cfg2 = makeConfig({});
    const summary2 = migrateChatsToV2(cfg2, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(summary2.legacyChatsMigrated).toBe(0);
    expect(summary2.legacyRegisteredGroupsMigrated).toBe(0);
    expect(summary2.noop).toBe(true);
  });

  it('agent_groups id-space unification: migrate then reconcile leaves a single row per folder', async () => {
    const { reconcileConfigToDb } = await import('./v2-reconcile.js');
    const db = open();
    // Seed legacy registered_groups so migrate creates (id='main', folder='main').
    db.exec(`CREATE TABLE registered_groups (
      jid TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      folder TEXT NOT NULL UNIQUE,
      trigger_pattern TEXT NOT NULL,
      added_at TEXT NOT NULL,
      container_config TEXT,
      requires_trigger INTEGER DEFAULT 1
    )`);
    db.prepare(
      `INSERT INTO registered_groups (jid, name, folder, trigger_pattern, added_at) VALUES (?, ?, ?, ?, ?)`,
    ).run('telegram:-100crew', 'Legacy Crew', 'main', '@bot', new Date().toISOString());

    migrateChatsToV2(makeConfig({}), db, { skipSaveConfig: true, skipSnapshot: true });

    // Now run reconcile with config.agents.list[].id='main' (same folder).
    const cfg = makeConfig({
      agents: {
        defaults: makeConfig().agents.defaults,
        list: [{ id: 'main', model: 'm', name: 'Main', triggerWord: '@m', hasOwnNumber: false, mode: 'host' }],
      },
    });
    expect(() => reconcileConfigToDb(cfg, db)).not.toThrow();

    const rows = db.prepare(`SELECT id, name, folder FROM agent_groups`).all() as Array<{
      id: string;
      name: string;
      folder: string;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe('main');
    expect(rows[0].folder).toBe('main');
    // Reconcile UPDATE semantics overwrite the legacy name with the declared one.
    expect(rows[0].name).toBe('Main');
  });
});

describe('migrateChatsToV2 — bindings emission (Flag 3)', () => {
  it('emits a binding for each chat with an explicit agentId', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {
        'telegram:8731': { name: 'Owner DM', isMain: true, agentId: 'main' },
        'telegram:42': { name: 'Friend DM', agentId: 'work' },
      },
    });
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    const bindings = (cfg.bindings ?? []).map((b) => ({
      agentId: b.agentId,
      channel: b.match?.channel,
      accountId: b.match?.accountId,
    }));
    expect(bindings).toEqual([
      { agentId: 'main', channel: 'telegram', accountId: 'default' },
      { agentId: 'work', channel: 'telegram', accountId: 'default' },
    ]);
  });

  it('dedupes bindings when multiple chats share the same (agentId, channel, account)', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {
        'telegram:8731': { name: 'Owner DM', isMain: true, agentId: 'main' },
        'telegram:-100crew': { name: 'Crew group', agentId: 'main' },
      },
    });
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(cfg.bindings).toHaveLength(1);
    expect(cfg.bindings![0]).toEqual({
      agentId: 'main',
      match: { channel: 'telegram', accountId: 'default' },
    });
  });

  it('chats without agentId fall back to a default binding for the channel (Bug 2 fix)', () => {
    // Bug 2 fix: legacy chats[] entries never carry agentId. Without a
    // default-binding fallback, the router has no agent to route to and
    // drops every inbound. Use first declared agent (or bootstrapped
    // 'main') as the binding target.
    const db = open();
    const cfg = makeConfig({
      chats: {
        'telegram:8731': { name: 'Owner DM', isMain: true },
      },
    });
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(cfg.bindings ?? []).toEqual([{ agentId: 'main', match: { channel: 'telegram', accountId: 'default' } }]);
  });
});

describe('migrateChatsToV2 — prod-shape regressions (4-bug batch)', () => {
  it('Bug 1: writes accounts under channelType, not the jid prefix (no fake `tg`/`tui` channels)', () => {
    const db = open();
    const cfg = makeConfig({
      chats: { 'tg:8731': { name: 'kenan-tg', isMain: true } },
    });
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    const channels = (
      cfg as unknown as { channels: Record<string, { accounts?: { default?: { allowFrom?: string[] } } }> }
    ).channels;
    expect(channels.telegram.accounts?.default?.allowFrom).toContain('8731');
    expect(channels.tg).toBeUndefined();
  });

  it('Bug 3: bootstraps agents.list = [{ id: "main", ...defaults }] when only defaults present', () => {
    const db = open();
    const cfg = makeConfig({
      chats: { 'telegram:8731': { name: 'Owner DM', isMain: true } },
    });
    expect(cfg.agents.list).toEqual([]);
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(cfg.agents.list).toHaveLength(1);
    expect(cfg.agents.list?.[0]?.id).toBe('main');
    expect(cfg.agents.list?.[0]?.name).toBe('D');
  });

  it('Bug 3 idempotent: existing agents.list is preserved (no second "main" appended)', () => {
    const db = open();
    const cfg = makeConfig({
      chats: { 'telegram:8731': { name: 'Owner DM', isMain: true } },
      agents: {
        defaults: { model: 'm', name: 'D', triggerWord: '@d', hasOwnNumber: false, mode: 'host' },
        list: [{ id: 'work', model: 'm', name: 'Work', triggerWord: '@w', hasOwnNumber: false, mode: 'host' }],
      },
    });
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    expect(cfg.agents.list?.map((a) => a.id)).toEqual(['work']);
    expect(cfg.bindings?.[0]?.agentId).toBe('work');
  });

  it('Bug 4: harvests channels.<k>.chats[] when top-level config.chats is empty', () => {
    const db = open();
    const cfg = makeConfig({
      chats: {},
      channels: {
        discord: { enabled: false },
        teams: { enabled: false, webhookPort: 3978, authMode: 'secret' },
        telegram: {
          enabled: true,
          chats: [{ jid: 'tg:8731', name: 'kenan-tg', isMain: true }],
        } as never,
      },
    });
    migrateChatsToV2(cfg, db, { skipSaveConfig: true, skipSnapshot: true });
    const channels = (
      cfg as unknown as { channels: Record<string, { accounts?: { default?: { allowFrom?: string[] } } }> }
    ).channels;
    expect(channels.telegram.accounts?.default?.allowFrom).toContain('8731');
    expect(cfg.bindings ?? []).toEqual([{ agentId: 'main', match: { channel: 'telegram', accountId: 'default' } }]);
  });
});
