/**
 * Fork migration 103: scheduled_tasks table (with all subsequent
 * ALTER columns folded in: context_mode, script,
 * consecutive_group_missing).
 *
 * Migrated from legacy `createSchema()` + ALTER blocks in `src/db.ts`.
 * This is the fork's first-class scheduling table that powers
 * `nanoclaw task list/info` CLI.
 *
 * Coexists with v2 `modules/scheduling/` model (`messages_in WHERE
 * kind='task'`). Decision in inventory matrix: keep both, fork
 * `scheduled_tasks` is canonical for fork-issued tasks; v2 module
 * available opt-in for series_id / cron-style upstream features.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration103ForkScheduledTasks: Migration = {
  version: 103,
  name: '103-fork-scheduled-tasks',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS scheduled_tasks (
        id TEXT PRIMARY KEY,
        group_folder TEXT NOT NULL,
        chat_jid TEXT NOT NULL,
        prompt TEXT NOT NULL,
        schedule_type TEXT NOT NULL,
        schedule_value TEXT NOT NULL,
        next_run TEXT,
        last_run TEXT,
        last_result TEXT,
        status TEXT DEFAULT 'active',
        consecutive_group_missing INTEGER DEFAULT 0,
        created_at TEXT NOT NULL,
        context_mode TEXT DEFAULT 'isolated',
        script TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_next_run ON scheduled_tasks(next_run);
      CREATE INDEX IF NOT EXISTS idx_status ON scheduled_tasks(status);
    `);
  },
};
