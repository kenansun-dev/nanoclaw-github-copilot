/**
 * Fork migration 104: task_run_logs table.
 *
 * Migrated from legacy `createSchema()` in `src/db.ts`. Per-run audit
 * trail for `scheduled_tasks` (migration 103). Used by
 * `nanoclaw task info <id>` to surface recent run history.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration104ForkTaskRunLogs: Migration = {
  version: 104,
  name: '104-fork-task-run-logs',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_run_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        run_at TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        FOREIGN KEY (task_id) REFERENCES scheduled_tasks(id)
      );
      CREATE INDEX IF NOT EXISTS idx_task_run_logs
        ON task_run_logs(task_id, run_at);
    `);
  },
};
