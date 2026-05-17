/**
 * Fork migration 108: dedupe `user_roles` and add a partial UNIQUE index
 * for the global-scope (`agent_group_id IS NULL`) case.
 *
 * Bug discovered 2026-05-16: `user_roles` PRIMARY KEY is
 * `(user_id, role, agent_group_id)`. SQLite treats two NULLs as distinct
 * in UNIQUE/PK comparisons (per ANSI), so `INSERT OR IGNORE` calls in
 * `reconcileConfigToDb` for owner roles (which use `agent_group_id=NULL`
 * for "global owner") never collide. Every boot appends another row.
 * VM smoke saw 3× rows after 3 boots.
 *
 * Fix:
 *   1. Collapse duplicates: keep `MIN(rowid)` per (user_id, role,
 *      COALESCE(agent_group_id, '')) and delete the rest.
 *   2. Add partial unique index covering the NULL case so subsequent
 *      `INSERT OR IGNORE` collides correctly. SQLite supports
 *      `CREATE UNIQUE INDEX ... WHERE ...` (partial indexes).
 *
 * The PK on (user_id, role, agent_group_id) is left in place — it still
 * dedupes the non-NULL case correctly. We only patch the NULL gap.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration108UserRolesDedup: Migration = {
  version: 108,
  name: '108-user-roles-dedup',
  up: (db: Database.Database) => {
    // Step 1: dedupe — keep oldest rowid per logical (user_id, role,
    // global-or-scoped agent_group_id). Use COALESCE so NULL groups
    // collapse together with their kin.
    db.exec(`
      DELETE FROM user_roles
       WHERE rowid NOT IN (
         SELECT MIN(rowid) FROM user_roles
          GROUP BY user_id, role, COALESCE(agent_group_id, '')
       )
    `);
    // Step 2: partial unique index for the NULL (global) scope.
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_user_roles_global_unique
          ON user_roles (user_id, role)
       WHERE agent_group_id IS NULL
    `);
  },
};
