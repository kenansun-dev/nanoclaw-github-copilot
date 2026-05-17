/**
 * Fork migration 105: v2 schema scaffolding for the config-shape-v2 work.
 *
 * The v2 tables (`agent_groups`, `messaging_groups`, `users`, `user_roles`,
 * `messaging_group_agents`, `agent_group_members`, ...) are already created
 * by upstream migration 001 (`initial-v2-schema`). What's missing for the
 * config-shape-v2 proposal is a single field:
 *
 *   `messaging_groups.account_key` — distinguishes which bot/account a chat
 *   row belongs to under a multi-account channel (e.g. `tg.personal` vs
 *   `tg.work`). Without this column the existing `UNIQUE(channel_type,
 *   platform_id)` constraint blocks the same chat from being seen under two
 *   different accounts of the same protocol.
 *
 * Schema delta:
 *   1. ALTER TABLE messaging_groups ADD COLUMN account_key (idempotent)
 *   2. Rebuild messaging_groups to swap UNIQUE(channel_type, platform_id)
 *      for UNIQUE(channel_type, account_key, platform_id).
 *
 * The rebuild touches FK references (messaging_group_agents,
 * dm_channel_for_user, sessions, ...). SQLite silently ignores
 * `PRAGMA foreign_keys` inside an open transaction, so this migration
 * sets `requiresForeignKeysOff: true` to make the runner toggle FK
 * enforcement *outside* the implicit migration transaction. Migration
 * 011's comment documents the historical incident this avoids.
 *
 * No data is migrated from the legacy `chats[]` config or the fork-only
 * `chats` table here. That work belongs to PR-B (config-shape-v2 runtime
 * + reconcile + chat migration).
 *
 * See docs/proposals/2026-05-12-config-shape-v2.md for the full design.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration105ForkV2Schema: Migration = {
  version: 105,
  name: '105-fork-v2-schema',
  requiresForeignKeysOff: true,
  up: (db: Database.Database) => {
    // Sanity: refuse to proceed if the runner forgot to honor the flag.
    // SQLite would otherwise silently corrupt FK invariants on DBs that
    // boot with `PRAGMA foreign_keys = ON` (prod connection.ts default).
    const fkOn = db.pragma('foreign_keys', { simple: true }) as 0 | 1;
    if (fkOn) {
      throw new Error(
        'migration 105: PRAGMA foreign_keys is ON inside the migration. ' +
          'The runner must call PRAGMA foreign_keys = OFF before opening the tx ' +
          'when requiresForeignKeysOff=true.',
      );
    }

    // 1. add account_key column if missing (idempotent on partial runs)
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{
      name: string;
    }>;
    if (!cols.some((c) => c.name === 'account_key')) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN account_key TEXT NOT NULL DEFAULT 'default'`);
    }

    // 2. table-rebuild to swap the UNIQUE constraint
    db.exec(`
      CREATE TABLE messaging_groups_new (
        id                    TEXT PRIMARY KEY,
        channel_type          TEXT NOT NULL,
        account_key           TEXT NOT NULL DEFAULT 'default',
        platform_id           TEXT NOT NULL,
        name                  TEXT,
        is_group              INTEGER DEFAULT 0,
        unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
        denied_at             TEXT,
        created_at            TEXT NOT NULL,
        UNIQUE(channel_type, account_key, platform_id)
      );

      INSERT INTO messaging_groups_new
        (id, channel_type, account_key, platform_id, name, is_group,
         unknown_sender_policy, denied_at, created_at)
      SELECT id, channel_type,
             COALESCE(account_key, 'default'),
             platform_id, name, is_group,
             unknown_sender_policy,
             ${cols.some((c) => c.name === 'denied_at') ? 'denied_at' : 'NULL'},
             created_at
      FROM messaging_groups;

      DROP TABLE messaging_groups;
      ALTER TABLE messaging_groups_new RENAME TO messaging_groups;
    `);

    // Note: dropped the explicit `CREATE INDEX idx_messaging_groups_lookup`
    // — UNIQUE(channel_type, account_key, platform_id) auto-creates an
    // equivalent covering index. Per Rpi5 review nit on PR #49.
  },
};
