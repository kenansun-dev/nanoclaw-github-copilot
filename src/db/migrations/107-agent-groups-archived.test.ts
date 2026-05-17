/**
 * Test for migration 107 — agent_groups.archived_at column.
 *
 * Verifies the column is added, the backfill from
 * `agent_provider='archived'` sentinel happens, and the sentinel is
 * cleaned up so `agent_provider` once again means "which runtime?"
 * exclusively.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';
import { migration107AgentGroupsArchived } from './107-agent-groups-archived.js';
import { migration001 } from './001-initial.js';
import { migration002 } from './002-chat-sdk-state.js';
import { moduleAgentToAgentDestinations } from './module-agent-to-agent-destinations.js';
import { migration008 } from './008-dropped-messages.js';
import { migration009 } from './009-drop-pending-credentials.js';
import { migration010 } from './010-engage-modes.js';
import { migration011 } from './011-pending-sender-approvals.js';
import { migration012 } from './012-channel-registration.js';
import { migration013 } from './013-approval-render-metadata.js';
import { migration014 } from './014-container-configs.js';
import { migration015 } from './015-cli-scope.js';
import { migration105ForkV2Schema } from './105-fork-v2-schema.js';
import { migration106PendingPairing } from './106-pending-pairing.js';
import { moduleApprovalsPendingApprovals } from './module-approvals-pending-approvals.js';
import { moduleApprovalsTitleOptions } from './module-approvals-title-options.js';

/**
 * Open a DB with every migration up to and INCLUDING 106 applied (i.e.
 * the schema as of just-before-this-migration). Lets us insert a row
 * carrying the legacy `agent_provider='archived'` sentinel and prove
 * migration 107 backfills + cleans it correctly.
 */
function openPre107(): Database.Database {
  const db = new Database(':memory:');
  const pre = [
    migration001,
    migration002,
    moduleApprovalsPendingApprovals,
    moduleAgentToAgentDestinations,
    moduleApprovalsTitleOptions,
    migration008,
    migration009,
    migration010,
    migration011,
    migration012,
    migration013,
    migration014,
    migration015,
    migration105ForkV2Schema,
    migration106PendingPairing,
  ];
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_schema_version_name ON schema_version(name);
  `);
  for (const m of pre) {
    const fkBefore = m.requiresForeignKeysOff ? (db.pragma('foreign_keys', { simple: true }) as 0 | 1) : 0;
    if (m.requiresForeignKeysOff && fkBefore) db.pragma('foreign_keys = OFF');
    try {
      db.transaction(() => {
        m.up(db);
        const next = (
          db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM schema_version').get() as { v: number }
        ).v;
        db.prepare('INSERT INTO schema_version (version, name, applied) VALUES (?, ?, ?)').run(
          next,
          m.name,
          new Date().toISOString(),
        );
      })();
    } finally {
      if (m.requiresForeignKeysOff && fkBefore) db.pragma('foreign_keys = ON');
    }
  }
  return db;
}

describe('migration 107: agent_groups.archived_at', () => {
  it('adds archived_at column (nullable TEXT)', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const cols = db.prepare("PRAGMA table_info('agent_groups')").all() as Array<{
      name: string;
      type: string;
      notnull: number;
    }>;
    const c = cols.find((x) => x.name === 'archived_at');
    expect(c).toBeTruthy();
    expect(c!.type).toBe('TEXT');
    expect(c!.notnull).toBe(0);
  });

  it("backfills archived_at from legacy agent_provider='archived' sentinel and clears it", () => {
    const db = openPre107();
    // Seed a row carrying the old sentinel.
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('old', 'Old', 'old', 'archived', new Date().toISOString());
    db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('alive', 'Alive', 'alive', 'host', new Date().toISOString());

    // Apply just migration 107.
    db.transaction(() => migration107AgentGroupsArchived.up(db))();

    const row = db.prepare(`SELECT agent_provider, archived_at FROM agent_groups WHERE id = ?`).get('old') as {
      agent_provider: string | null;
      archived_at: string | null;
    };
    expect(row.agent_provider).toBeNull();
    expect(typeof row.archived_at).toBe('string');
    expect(row.archived_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const alive = db.prepare(`SELECT agent_provider, archived_at FROM agent_groups WHERE id = ?`).get('alive') as {
      agent_provider: string | null;
      archived_at: string | null;
    };
    expect(alive.agent_provider).toBe('host');
    expect(alive.archived_at).toBeNull();
  });

  it('migration is part of the default migration set', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    const names = (db.prepare('SELECT name FROM schema_version').all() as { name: string }[]).map((r) => r.name);
    expect(names).toContain('107-agent-groups-archived');
  });
});
