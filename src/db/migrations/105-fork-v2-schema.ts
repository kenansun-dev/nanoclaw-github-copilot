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
 * This migration:
 *   1. Adds `messaging_groups.account_key TEXT NOT NULL DEFAULT 'default'`
 *      (idempotent; existing rows backfill to `'default'`).
 *   2. Replaces the unique constraint with `(channel_type, account_key,
 *      platform_id)` via SQLite's table-rebuild idiom.
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
  up: (db: Database.Database) => {
    // 1. add account_key column if missing
    const cols = db.prepare("PRAGMA table_info('messaging_groups')").all() as Array<{
      name: string;
    }>;
    const hasAccountKey = cols.some((c) => c.name === 'account_key');
    if (!hasAccountKey) {
      db.exec(`ALTER TABLE messaging_groups ADD COLUMN account_key TEXT NOT NULL DEFAULT 'default'`);
    }

    // 2. replace the (channel_type, platform_id) UNIQUE with a 3-tuple.
    //    Table rebuild is the SQLite-native way; FKs are preserved because
    //    referencing tables (messaging_group_agents, dm_channel_for_user,
    //    sessions, etc.) reference messaging_groups.id which we keep intact.
    //
    //    PRAGMA foreign_keys=OFF is set transactionally by the caller of the
    //    migration runner; better-sqlite3 default is OFF anyway. We re-enable
    //    in case the runner ever flips it.
    const fkPrev = (
      db.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number } | undefined
    )?.foreign_keys;
    if (fkPrev) db.exec('PRAGMA foreign_keys=OFF');

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

      CREATE INDEX IF NOT EXISTS idx_messaging_groups_lookup
        ON messaging_groups(channel_type, account_key, platform_id);
    `);

    if (fkPrev) db.exec('PRAGMA foreign_keys=ON');
  },
};
