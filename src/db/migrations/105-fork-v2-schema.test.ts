/**
 * Test for migration 105 — adds messaging_groups.account_key and rebuilds
 * the UNIQUE constraint to the (channel_type, account_key, platform_id)
 * 3-tuple required by the config-shape-v2 proposal.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

describe('migration 105: messaging_groups.account_key', () => {
  function open(): Database.Database {
    const db = new Database(':memory:');
    runMigrations(db);
    return db;
  }

  it('messaging_groups has account_key column with default "default"', () => {
    const db = open();
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{
      name: string;
      dflt_value: string | null;
    }>;
    const account = cols.find((c) => c.name === 'account_key');
    expect(account).toBeTruthy();
    expect(account?.dflt_value).toContain('default');
  });

  it('UNIQUE is now (channel_type, account_key, platform_id) — same chat under two accounts is allowed', () => {
    const db = open();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, account_key, platform_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('mg-personal', 'telegram', 'personal', '8731', now);
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, account_key, platform_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('mg-work', 'telegram', 'work', '8731', now);

    const rows = db.prepare(`SELECT id FROM messaging_groups WHERE platform_id = ?`).all('8731') as { id: string }[];
    expect(rows.map((r) => r.id).sort()).toEqual(['mg-personal', 'mg-work']);
  });

  it('UNIQUE still rejects duplicate (channel_type, account_key, platform_id)', () => {
    const db = open();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO messaging_groups (id, channel_type, account_key, platform_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('mg1', 'telegram', 'default', '8731', now);

    expect(() =>
      db
        .prepare(
          `INSERT INTO messaging_groups (id, channel_type, account_key, platform_id, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('mg2', 'telegram', 'default', '8731', now),
    ).toThrow(/UNIQUE/);
  });

  it('legacy v2 tables still present (sanity: 001 not regressed)', () => {
    const db = open();
    const tables = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN
                ('agent_groups','users','user_roles','agent_group_members')`,
      )
      .all() as { name: string }[];
    expect(tables.length).toBe(4);
  });

  it('migration is idempotent across reopens', () => {
    const db = open();
    runMigrations(db);
    runMigrations(db);
    const versions = db.prepare(`SELECT name FROM schema_version WHERE name = ?`).all('105-fork-v2-schema');
    expect(versions.length).toBe(1);
  });

  it('runs cleanly with FK=ON before runMigrations (prod connection.ts mode)', () => {
    // Reproduces prod: connection.ts boots with PRAGMA foreign_keys = ON.
    // The runner must toggle it OFF outside the implicit migration tx,
    // because PRAGMA foreign_keys is silently ignored inside a transaction.
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    expect(() => runMigrations(db)).not.toThrow();

    // FK enforcement should be restored to ON after the migration runs.
    const fkAfter = db.pragma('foreign_keys', { simple: true }) as 0 | 1;
    expect(fkAfter).toBe(1);

    // Schema delta still applied.
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{
      name: string;
    }>;
    expect(cols.some((c) => c.name === 'account_key')).toBe(true);
  });

  it('throws if the runner forgets to honor requiresForeignKeysOff', async () => {
    // White-box: invoke the migration directly with FK=ON and confirm the
    // sanity guard inside up() fires.
    const { migration105ForkV2Schema } = await import('./105-fork-v2-schema.js');
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE messaging_groups (
        id TEXT PRIMARY KEY,
        channel_type TEXT NOT NULL,
        platform_id TEXT NOT NULL,
        name TEXT,
        is_group INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
        denied_at TEXT,
        created_at TEXT NOT NULL,
        UNIQUE(channel_type, platform_id)
      );
    `);
    db.pragma('foreign_keys = ON');
    expect(() => migration105ForkV2Schema.up(db)).toThrow(/foreign_keys is ON/);
  });
});
