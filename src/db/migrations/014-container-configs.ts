/**
 * Migration 014: container_configs — manual port from upstream commit 31ccc61
 * (`feat(db): move container config from filesystem to DB`).
 *
 * This fork has no runtime callsites for `container_configs` yet. The table
 * is included purely to keep the migration numbering aligned with upstream
 * and ease future merges. Population/read code can land later without
 * needing another schema bump.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration014: Migration = {
  version: 14,
  name: 'container-configs',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE container_configs (
        agent_group_id        TEXT PRIMARY KEY REFERENCES agent_groups(id) ON DELETE CASCADE,
        provider              TEXT,
        model                 TEXT,
        effort                TEXT,
        image_tag             TEXT,
        assistant_name        TEXT,
        max_messages_per_prompt INTEGER,
        skills                TEXT NOT NULL DEFAULT '"all"',
        mcp_servers           TEXT NOT NULL DEFAULT '{}',
        packages_apt          TEXT NOT NULL DEFAULT '[]',
        packages_npm          TEXT NOT NULL DEFAULT '[]',
        additional_mounts     TEXT NOT NULL DEFAULT '[]',
        updated_at            TEXT NOT NULL
      );
    `);
  },
};
