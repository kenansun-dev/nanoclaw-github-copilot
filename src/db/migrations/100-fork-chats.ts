/**
 * Fork migration 100: chats + messages tables.
 *
 * Migrated from the legacy fork `createSchema()` in `src/db.ts`. Tracks
 * per-channel chat metadata + raw message archive used by audit and
 * chat-manager.
 *
 * Numbered 100+ to leave 003..099 reserved for upstream v2 migrations.
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration100Forkchats: Migration = {
  version: 100,
  name: '100-fork-chats',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS chats (
        jid TEXT PRIMARY KEY,
        name TEXT,
        last_message_time TEXT,
        channel TEXT,
        is_group INTEGER DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT,
        chat_jid TEXT,
        sender TEXT,
        sender_name TEXT,
        content TEXT,
        timestamp TEXT,
        is_from_me INTEGER,
        is_bot_message INTEGER DEFAULT 0,
        PRIMARY KEY (id, chat_jid),
        FOREIGN KEY (chat_jid) REFERENCES chats(jid)
      );
      CREATE INDEX IF NOT EXISTS idx_timestamp ON messages(timestamp);
    `);
  },
};
