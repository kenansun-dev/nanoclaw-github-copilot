/**
 * Fork migration 101: sender_allowlist table.
 *
 * NOTE: Fork sender-allowlist (`src/sender-allowlist.ts`) is currently
 * file-backed (`SENDER_ALLOWLIST_PATH`) + config-backed
 * (`security.allowedSenders`), not DB-backed. This migration reserves
 * the table name for B.4 module port that will move runtime state
 * into SQL alongside v2's `pending_sender_approvals` (migration 011).
 *
 * Stub schema; B.4 will add the real columns + indexes when porting
 * the allowlist into the v2 modules layer.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration101ForkSenderAllowlist: Migration = {
  version: 101,
  name: '101-fork-sender-allowlist',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sender_allowlist (
        chat_jid TEXT NOT NULL,
        sender TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'trigger',
        added_at TEXT NOT NULL DEFAULT (datetime('now')),
        added_by TEXT,
        PRIMARY KEY (chat_jid, sender)
      );
      CREATE INDEX IF NOT EXISTS idx_sender_allowlist_chat
        ON sender_allowlist(chat_jid);
    `);
  },
};
