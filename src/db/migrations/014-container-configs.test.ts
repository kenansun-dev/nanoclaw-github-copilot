import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

describe('migration 014: container_configs', () => {
  it('creates container_configs table with expected columns', () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='container_configs'`)
      .all() as { name: string }[];
    expect(tables.length).toBe(1);

    const cols = (db.prepare(`PRAGMA table_info(container_configs)`).all() as { name: string }[]).map((c) => c.name);
    expect(cols).toEqual(
      expect.arrayContaining([
        'agent_group_id',
        'provider',
        'model',
        'effort',
        'image_tag',
        'assistant_name',
        'max_messages_per_prompt',
        'skills',
        'mcp_servers',
        'packages_apt',
        'packages_npm',
        'additional_mounts',
        'updated_at',
      ]),
    );
  });

  it('FK to agent_groups(id) is wired and cascades on delete', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`).run(
      'ag-1',
      'test',
      'test',
      now,
    );
    db.prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run('ag-1', now);

    db.prepare(`DELETE FROM agent_groups WHERE id = ?`).run('ag-1');
    const remaining = db.prepare(`SELECT COUNT(*) AS c FROM container_configs`).get() as { c: number };
    expect(remaining.c).toBe(0);
  });

  it('is idempotent (re-running migrations does not crash)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
  });
});
