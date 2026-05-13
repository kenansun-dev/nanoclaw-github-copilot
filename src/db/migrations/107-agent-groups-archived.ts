/**
 * Fork migration 107: dedicated `archived_at` column on agent_groups
 * (fixup #49 step 9.5 gap 2 — owner audit).
 *
 * Previously, reconcileConfigToDb (`src/db/v2-reconcile.ts`) tagged
 * agents that were removed from config by overwriting
 * `agent_provider = 'archived'`. That poisons the `agent_provider`
 * semantic (it conflates "which runtime?" with "is this still
 * declared?"), prevents recovering the real provider on un-archive,
 * and makes downstream queries that filter on `agent_provider` brittle.
 *
 * This migration:
 *
 *   1. Adds a real `archived_at TEXT NULL` column.
 *   2. Backfills `archived_at = datetime('now')` for any row whose
 *      `agent_provider = 'archived'` sentinel value is present.
 *   3. Clears the sentinel itself (sets `agent_provider = NULL` so the
 *      column once again means "runtime/provider" only).
 *
 * Re-declaration of a previously archived agent un-sets `archived_at`
 * back to NULL (see v2-reconcile.ts).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration107AgentGroupsArchived: Migration = {
  version: 107,
  name: '107-agent-groups-archived',
  up: (db: Database.Database) => {
    // ALTER TABLE ADD COLUMN is cheap on SQLite (no rebuild) and FK-safe.
    db.exec(`ALTER TABLE agent_groups ADD COLUMN archived_at TEXT NULL`);
    db.prepare(
      `UPDATE agent_groups
          SET archived_at = datetime('now')
        WHERE agent_provider = 'archived'`,
    ).run();
    db.prepare(
      `UPDATE agent_groups
          SET agent_provider = NULL
        WHERE agent_provider = 'archived'`,
    ).run();
  },
};
