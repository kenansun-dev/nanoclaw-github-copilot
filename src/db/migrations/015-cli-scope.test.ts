import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

describe('migration 015: cli-scope', () => {
  it("adds cli_scope column with default 'group'", () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const cols = db.prepare(`PRAGMA table_info(container_configs)`).all() as {
      name: string;
      dflt_value: string | null;
      notnull: number;
    }[];
    const cli = cols.find((c) => c.name === 'cli_scope');
    expect(cli).toBeDefined();
    expect(cli?.notnull).toBe(1);
    // SQLite reports default as the literal SQL fragment (quoted)
    expect(cli?.dflt_value).toBe("'group'");
  });

  it("inserted row picks up the 'group' default when cli_scope is omitted", () => {
    const db = new Database(':memory:');
    runMigrations(db);

    const now = new Date().toISOString();
    db.prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`).run(
      'ag-1',
      'test',
      'test',
      now,
    );
    db.prepare(`INSERT INTO container_configs (agent_group_id, updated_at) VALUES (?, ?)`).run('ag-1', now);

    const row = db.prepare(`SELECT cli_scope FROM container_configs WHERE agent_group_id = ?`).get('ag-1') as {
      cli_scope: string;
    };
    expect(row.cli_scope).toBe('group');
  });
});
