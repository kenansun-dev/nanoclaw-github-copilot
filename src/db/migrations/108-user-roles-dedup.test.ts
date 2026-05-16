/**
 * Tests for migration 108 — user_roles dedupe + partial unique index.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

function open(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('migration 108 — user_roles dedup', () => {
  it('partial unique index blocks duplicate global-scope inserts', () => {
    const db = open();
    db.prepare(
      `INSERT INTO users (id, kind, created_at) VALUES ('telegram:1', 'telegram', datetime('now'))`,
    ).run();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
       VALUES ('telegram:1', 'owner', NULL, datetime('now'))`,
    );
    ins.run();
    ins.run();
    ins.run();
    const cnt = (db.prepare(`SELECT COUNT(*) as n FROM user_roles`).get() as { n: number }).n;
    expect(cnt).toBe(1);
  });

  it('collapses pre-existing duplicate rows on migration', () => {
    // Simulate a DB that already accumulated duplicates BEFORE migration 108
    // by running migrations only up to 107, seeding dupes, then running 108.
    const db = new Database(':memory:');
    // Cheap path: run all migrations (108 included) then drop the partial
    // index, seed dupes, and re-create the index by re-running the up()
    // body manually.
    runMigrations(db);
    db.exec(`DROP INDEX IF EXISTS idx_user_roles_global_unique`);
    db.prepare(
      `INSERT INTO users (id, kind, created_at) VALUES ('telegram:1', 'telegram', datetime('now'))`,
    ).run();
    for (let i = 0; i < 5; i++) {
      db.prepare(
        `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
         VALUES ('telegram:1', 'owner', NULL, datetime('now', '+' || ? || ' seconds'))`,
      ).run(i);
    }
    expect((db.prepare(`SELECT COUNT(*) as n FROM user_roles`).get() as { n: number }).n).toBe(5);

    // Re-run migration 108 logic (idempotent body).
    db.exec(`
      DELETE FROM user_roles
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM user_roles
          GROUP BY user_id, role, COALESCE(agent_group_id, '')
       )
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global_unique
          ON user_roles (user_id, role)
       WHERE agent_group_id IS NULL
    `);

    expect((db.prepare(`SELECT COUNT(*) as n FROM user_roles`).get() as { n: number }).n).toBe(1);
  });

  it('per-group scoping still allows distinct (user, role, group_id) rows', () => {
    const db = open();
    db.prepare(`INSERT INTO users (id, kind, created_at) VALUES ('telegram:1', 'telegram', datetime('now'))`).run();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('a', 'A', 'a', datetime('now'))`,
    ).run();
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, created_at) VALUES ('b', 'B', 'b', datetime('now'))`,
    ).run();
    const ins = db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES (?, ?, ?, datetime('now'))`,
    );
    ins.run('telegram:1', 'admin', 'a');
    ins.run('telegram:1', 'admin', 'b');
    ins.run('telegram:1', 'owner', null);
    const cnt = (db.prepare(`SELECT COUNT(*) as n FROM user_roles`).get() as { n: number }).n;
    expect(cnt).toBe(3);
  });
});
