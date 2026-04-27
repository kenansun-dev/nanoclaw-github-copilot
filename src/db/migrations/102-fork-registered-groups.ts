/**
 * Fork migration 102: registered_groups table.
 *
 * Migrated from legacy `createSchema()` in `src/db.ts`. Tracks chat
 * groups that have been bound to an agent + container config (the
 * fork's pre-v2 alternative to v2 `agent_groups`/`messaging_groups`
 * pair from migration 001).
 *
 * Phase B.5 will decide whether to keep both schemas (fork uses
 * `registered_groups`, v2 modules use `agent_groups`) or unify on
 * the v2 model with a backfill.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration102ForkRegisteredGroups: Migration = {
  version: 102,
  name: '102-fork-registered-groups',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS registered_groups (
        jid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder TEXT NOT NULL UNIQUE,
        trigger_pattern TEXT NOT NULL,
        added_at TEXT NOT NULL,
        container_config TEXT,
        requires_trigger INTEGER DEFAULT 1
      );
    `);
  },
};
