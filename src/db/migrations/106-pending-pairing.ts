/**
 * Fork migration 106: pairing-flow tables for fixup #49 step 7.
 *
 * Adds two tables consumed by `src/v2-access.ts` (`holdMessageForPairing`
 * + `redeemPairingCode`) and the CLI/slash redemption commands:
 *
 *   - `pending_messages` — strangers' DMs held while waiting for owner
 *     approval. TTL'd via `expires_at` (default 24h). Replayed when a
 *     matching pairing code is redeemed; swept at boot and on each new
 *     hold so the queue never accretes dead rows.
 *
 *   - `pairing_codes` — short-lived (24h) codes that represent a
 *     pending-pair offer for a (channel, account, peer) triple. The code
 *     itself is the primary key (8 unambiguous chars from the Crockford
 *     alphabet, formatted XXXX-XXXX for humans — see `src/pairing/code.ts`).
 *     One code per first hold; subsequent holds from the same peer
 *     simply append to `pending_messages` without minting a new code.
 *
 * See docs/proposals/2026-05-12-config-shape-v2.md (pairing flow section)
 * and the PR #49 step-7 discussion for the design rationale (notably the
 * brute-force entropy argument against 6-digit numeric codes).
 */
import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration106PendingPairing: Migration = {
  version: 106,
  name: '106-pending-pairing',
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS pending_messages (
        id            TEXT PRIMARY KEY,
        channel_type  TEXT NOT NULL,
        account_key   TEXT NOT NULL DEFAULT 'default',
        peer_id       TEXT NOT NULL,
        payload_json  TEXT NOT NULL,
        received_at   TEXT NOT NULL,
        expires_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_messages_peer
        ON pending_messages(channel_type, account_key, peer_id);
      CREATE INDEX IF NOT EXISTS idx_pending_messages_expires
        ON pending_messages(expires_at);

      CREATE TABLE IF NOT EXISTS pairing_codes (
        code             TEXT PRIMARY KEY,
        channel_type     TEXT NOT NULL,
        account_key      TEXT NOT NULL DEFAULT 'default',
        peer_id          TEXT NOT NULL,
        target_agent_id  TEXT,
        created_at       TEXT NOT NULL,
        expires_at       TEXT NOT NULL,
        redeemed_at      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_expires
        ON pairing_codes(expires_at);
      CREATE INDEX IF NOT EXISTS idx_pairing_codes_peer
        ON pairing_codes(channel_type, account_key, peer_id);
    `);
  },
};
