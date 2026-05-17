/**
 * Migration 015: cli-scope — manual port from upstream commit aebcffe
 * (`feat: per-group CLI scope (disabled/group/global)`).
 *
 * Adds a `cli_scope` column to `container_configs` with default `'group'`.
 * Schema-only port; runtime enforcement lives in upstream code paths the
 * fork hasn't ported yet.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration015: Migration = {
  version: 15,
  name: 'cli-scope',
  up(db: Database.Database) {
    db.prepare("ALTER TABLE container_configs ADD COLUMN cli_scope TEXT NOT NULL DEFAULT 'group'").run();
  },
};
