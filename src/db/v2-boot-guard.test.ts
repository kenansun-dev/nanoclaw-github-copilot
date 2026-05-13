/**
 * Tests for `prepareForV2Migrations` (src/db/v2-boot-guard.ts).
 *
 * The guard exists because the legacy fork's `createSchema()` produced a
 * `sessions` table on disk (at `~/.nanoclaw/store/messages.db`) keyed on
 * `(group_folder, provider)`. Upstream migration 001 (re)creates `sessions`
 * with a different shape and without `IF NOT EXISTS`, so on any existing
 * prod DB migration 001 would crash. The guard renames the legacy table
 * out of the way **before** 001 runs.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareForV2Migrations } from './v2-boot-guard.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'v2-boot-guard-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Recreate the legacy fork `createSchema()` shape that matters for the guard. */
function buildLegacySessionsDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE sessions (
      group_folder TEXT NOT NULL,
      provider     TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      PRIMARY KEY (group_folder, provider)
    );
    CREATE TABLE chats (
      jid       TEXT PRIMARY KEY,
      name      TEXT,
      is_group  INTEGER NOT NULL DEFAULT 0,
      timestamp TEXT
    );
  `);
  db.prepare(`INSERT INTO sessions (group_folder, provider, session_id) VALUES (?, ?, ?)`).run(
    'work/agent-a',
    'anthropic',
    'sess-1',
  );
  db.close();
}

describe('prepareForV2Migrations', () => {
  it('renames legacy sessions table and creates a backup file', () => {
    const dbPath = path.join(tmpDir, 'messages.db');
    buildLegacySessionsDb(dbPath);

    const db = new Database(dbPath);
    const fired = prepareForV2Migrations(db, dbPath);
    expect(fired).toBe(true);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    const names = tables.map((t) => t.name);
    expect(names).toContain('sessions_legacy_v1');
    expect(names).not.toContain('sessions');

    // Data preserved under the new name.
    const row = db.prepare(`SELECT session_id FROM sessions_legacy_v1`).get() as { session_id: string };
    expect(row.session_id).toBe('sess-1');

    // Backup created and non-empty.
    const backupPath = `${dbPath}.pre-v2.bak`;
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(fs.statSync(backupPath).size).toBeGreaterThan(0);

    db.close();
  });

  it('is a no-op on a fresh v2 schema (no legacy sessions table)', () => {
    const dbPath = path.join(tmpDir, 'fresh.db');
    const db = new Database(dbPath);
    // Simulate post-001 state: sessions exists with v2 shape.
    db.exec(`
      CREATE TABLE sessions (
        id                 TEXT PRIMARY KEY,
        agent_group_id     TEXT NOT NULL,
        messaging_group_id TEXT,
        thread_id          TEXT,
        agent_provider     TEXT,
        status             TEXT,
        container_status   TEXT,
        last_active        TEXT,
        created_at         TEXT NOT NULL
      );
      CREATE TABLE schema_version (version INTEGER, name TEXT, applied TEXT);
      INSERT INTO schema_version VALUES (1, '001-initial', '2026-01-01');
    `);

    const fired = prepareForV2Migrations(db, dbPath);
    expect(fired).toBe(false);
    expect(fs.existsSync(`${dbPath}.pre-v2.bak`)).toBe(false);

    db.close();
  });

  it('is idempotent: second call after rename is a no-op', () => {
    const dbPath = path.join(tmpDir, 'idem.db');
    buildLegacySessionsDb(dbPath);

    const db = new Database(dbPath);
    expect(prepareForV2Migrations(db, dbPath)).toBe(true);

    // Remove the backup so we can detect whether the second call rewrites it.
    fs.unlinkSync(`${dbPath}.pre-v2.bak`);

    expect(prepareForV2Migrations(db, dbPath)).toBe(false);
    expect(fs.existsSync(`${dbPath}.pre-v2.bak`)).toBe(false);

    db.close();
  });

  it('handles :memory: dbs without crashing and skips backup', () => {
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE sessions (
        group_folder TEXT NOT NULL,
        provider     TEXT NOT NULL,
        session_id   TEXT NOT NULL,
        PRIMARY KEY (group_folder, provider)
      );
    `);

    const fired = prepareForV2Migrations(db, ':memory:');
    expect(fired).toBe(true);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`)
      .all() as { name: string }[];
    expect(tables.map((t) => t.name)).toContain('sessions_legacy_v1');

    db.close();
  });

  it('does nothing on a completely empty db', () => {
    const dbPath = path.join(tmpDir, 'empty.db');
    const db = new Database(dbPath);

    const fired = prepareForV2Migrations(db, dbPath);
    expect(fired).toBe(false);
    expect(fs.existsSync(`${dbPath}.pre-v2.bak`)).toBe(false);

    db.close();
  });
});
