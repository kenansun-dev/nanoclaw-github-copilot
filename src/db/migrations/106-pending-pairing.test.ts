/**
 * Test for migration 106 — pending_messages + pairing_codes tables.
 */
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { runMigrations } from './index.js';

function open(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}

describe('migration 106: pending_messages + pairing_codes', () => {
  it('pending_messages table exists with expected columns', () => {
    const db = open();
    const cols = db.prepare("PRAGMA table_info('pending_messages')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      ['account_key', 'channel_type', 'expires_at', 'id', 'payload_json', 'peer_id', 'received_at'].sort(),
    );
  });

  it('pairing_codes table exists with expected columns', () => {
    const db = open();
    const cols = db.prepare("PRAGMA table_info('pairing_codes')").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name).sort();
    expect(names).toEqual(
      [
        'account_key',
        'channel_type',
        'code',
        'created_at',
        'expires_at',
        'peer_id',
        'redeemed_at',
        'target_agent_id',
      ].sort(),
    );
  });

  it('expected indexes exist on both tables', () => {
    const db = open();
    const idx = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name IN ('pending_messages','pairing_codes')`)
      .all() as { name: string }[];
    const names = idx.map((r) => r.name);
    expect(names).toContain('idx_pending_messages_peer');
    expect(names).toContain('idx_pending_messages_expires');
    expect(names).toContain('idx_pairing_codes_expires');
    expect(names).toContain('idx_pairing_codes_peer');
  });

  it('migration is idempotent across reopens', () => {
    const db = open();
    runMigrations(db);
    runMigrations(db);
    const rows = db.prepare(`SELECT name FROM schema_version WHERE name = ?`).all('106-pending-pairing');
    expect(rows.length).toBe(1);
  });
});
