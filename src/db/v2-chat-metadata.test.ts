import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, initTestDb, closeDb } from './connection.js';
import {
  getRegisteredGroupV2,
  getAllRegisteredGroupsV2,
  compareV1V2ChatMetadata,
} from './v2-chat-metadata.js';
import type { RegisteredGroup } from '../types-extensions.js';

function seedV2(rows: Array<{ id: string; channel_type: string; platform_id: string; name: string; agent_group_id: string; engage_pattern?: string; engage_mode?: string }>): void {
  const db = getDb();
  // Minimal v2 tables for the test (subset of 105-fork-v2-schema)
  db.exec(`
    CREATE TABLE IF NOT EXISTS messaging_groups (
      id TEXT PRIMARY KEY, channel_type TEXT NOT NULL, account_key TEXT NOT NULL DEFAULT 'default',
      platform_id TEXT NOT NULL, name TEXT, is_group INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict', denied_at TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(channel_type, account_key, platform_id)
    );
    CREATE TABLE IF NOT EXISTS agent_groups (id TEXT PRIMARY KEY, name TEXT, archived_at TEXT);
    CREATE TABLE IF NOT EXISTS messaging_group_agents (
      id TEXT PRIMARY KEY,
      messaging_group_id TEXT NOT NULL REFERENCES messaging_groups(id),
      agent_group_id TEXT NOT NULL REFERENCES agent_groups(id),
      trigger_rules TEXT, engage_mode TEXT, engage_pattern TEXT,
      sender_scope TEXT, ignored_message_policy TEXT,
      response_scope TEXT DEFAULT 'all',
      session_mode TEXT DEFAULT 'shared',
      priority INTEGER DEFAULT 0,
      created_at TEXT NOT NULL,
      UNIQUE(messaging_group_id, agent_group_id)
    );
  `);
  for (const r of rows) {
    db.prepare(`INSERT OR IGNORE INTO agent_groups (id, name) VALUES (?, ?)`).run(r.agent_group_id, r.agent_group_id);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(r.id, r.channel_type, r.platform_id, r.name, '2026-05-16T00:00:00Z');
    db.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(`mga-${r.id}`, r.id, r.agent_group_id, r.engage_mode ?? 'always', r.engage_pattern ?? '', '2026-05-16T00:00:00Z');
  }
}

describe('v2-chat-metadata bridge', () => {
  beforeEach(() => {
    initTestDb();
  });
  afterEach(() => {
    closeDb();
  });

  it('getRegisteredGroupV2 maps telegram MG → tg: jid', () => {
    seedV2([{ id: 'mg-1', channel_type: 'telegram', platform_id: '8731187021', name: 'kenan', agent_group_id: 'main' }]);
    const r = getRegisteredGroupV2('tg:8731187021');
    expect(r).toBeDefined();
    expect(r!.jid).toBe('tg:8731187021');
    expect(r!.folder).toBe('main');
    expect(r!.name).toBe('kenan');
  });

  it('getRegisteredGroupV2 preserves multi-colon platform_id (Teams thread)', () => {
    seedV2([{ id: 'mg-2', channel_type: 'teams', platform_id: 'a:1Rw3-thread-id', name: 'team', agent_group_id: 'teams-main' }]);
    const r = getRegisteredGroupV2('teams:a:1Rw3-thread-id');
    expect(r).toBeDefined();
    expect(r!.folder).toBe('teams-main');
  });

  it('getRegisteredGroupV2 returns undefined for unknown jid', () => {
    seedV2([]);
    expect(getRegisteredGroupV2('tg:nonexistent')).toBeUndefined();
  });

  it('getRegisteredGroupV2 returns undefined for malformed jid', () => {
    seedV2([{ id: 'mg-3', channel_type: 'telegram', platform_id: '1', name: 'x', agent_group_id: 'main' }]);
    expect(getRegisteredGroupV2('nojidshape')).toBeUndefined();
  });

  it('getAllRegisteredGroupsV2 returns all wired chats', () => {
    seedV2([
      { id: 'mg-1', channel_type: 'telegram', platform_id: '8731187021', name: 'kenan', agent_group_id: 'main' },
      { id: 'mg-2', channel_type: 'tui', platform_id: 'default', name: 'tui', agent_group_id: 'main' },
    ]);
    const all = getAllRegisteredGroupsV2();
    expect(Object.keys(all).sort()).toEqual(['tg:8731187021', 'tui:default']);
  });

  it('getAllRegisteredGroupsV2 skips unwired MG rows (no MGA join)', () => {
    seedV2([{ id: 'mg-x', channel_type: 'telegram', platform_id: '99', name: 'wired', agent_group_id: 'main' }]);
    // unwired row
    getDb().prepare(`INSERT INTO messaging_groups (id, channel_type, platform_id, created_at) VALUES (?,?,?,?)`).run('mg-y', 'telegram', '88', '2026-05-16T00:00:00Z');
    const all = getAllRegisteredGroupsV2();
    expect(Object.keys(all)).toEqual(['tg:99']);
  });

  it('engage_mode != always → requiresTrigger=true', () => {
    seedV2([{ id: 'mg-1', channel_type: 'telegram', platform_id: '1', name: 'g', agent_group_id: 'main', engage_mode: 'mention', engage_pattern: '@bot' }]);
    const r = getRegisteredGroupV2('tg:1');
    expect(r!.requiresTrigger).toBe(true);
    expect(r!.trigger).toBe('@bot');
  });

  describe('compareV1V2ChatMetadata', () => {
    const v2Row = { jid: 'tg:1', name: 'kenan', folder: 'main', trigger: '', added_at: 't', requiresTrigger: false };

    it('reports zero drift when matching', () => {
      const v1: Record<string, RegisteredGroup> = { 'tg:1': { name: 'kenan', folder: 'main', trigger: '', added_at: 't' } };
      const v2 = { 'tg:1': v2Row };
      const d = compareV1V2ChatMetadata(v1, v2);
      expect(d).toEqual({ v1OnlyJids: [], v2OnlyJids: [], fieldMismatchJids: [] });
    });

    it('reports v1-only', () => {
      const v1: Record<string, RegisteredGroup> = { 'tg:1': { name: 'k', folder: 'main', trigger: '', added_at: 't' } };
      const d = compareV1V2ChatMetadata(v1, {});
      expect(d.v1OnlyJids).toEqual(['tg:1']);
    });

    it('reports v2-only', () => {
      const d = compareV1V2ChatMetadata({}, { 'tg:1': v2Row });
      expect(d.v2OnlyJids).toEqual(['tg:1']);
    });

    it('reports field mismatch (folder)', () => {
      const v1: Record<string, RegisteredGroup> = { 'tg:1': { name: 'kenan', folder: 'OTHER', trigger: '', added_at: 't' } };
      const d = compareV1V2ChatMetadata(v1, { 'tg:1': v2Row });
      expect(d.fieldMismatchJids).toEqual(['tg:1']);
    });
  });
});
