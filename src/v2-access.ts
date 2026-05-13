/**
 * v2 pairing hold + redemption — fixup #49 PR-D.
 *
 * Pair flow: a config-allowed user's first DM is held, the user receives an
 * 8-character code, and the owner redeems it via `/pair-approve <CODE>` or
 * `nanoclaw pair-approve`. This is a device-ownership confirmation step,
 * separate from access control. Access is decided upstream by the
 * permissions module (`src/modules/permissions/access.ts:canAccessAgentGroup`)
 * after `src/db/v2-reconcile.ts` projects config-declared users into
 * `agent_group_members` and owners into `user_roles`.
 *
 * The previous `checkInboundAccess` config-driven gate was removed in PR-D
 * (owner directive 2026-05-13 "复用上游表、别造轮子"); router now relies on the
 * upstream `setAccessGate` registered by `src/modules/permissions/index.ts`.
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { log } from './log.js';
import { generatePairingCode, normalizePairingCode } from './pairing/code.js';

/**
 * Default TTL for held messages and unredeemed pairing codes (24h).
 * Pairing codes share this TTL: a code without an active hold is useless,
 * and a held message without a live code can never be approved.
 */
export const PAIRING_HOLD_TTL_MS = 24 * 60 * 60 * 1000;

export interface HoldMessagePayload {
  /** Plain text body (used for the replay log). */
  text: string;
  /** Optional adapter-specific raw message (JSON-serializable). */
  raw?: unknown;
  /** Best-effort display name for the stranger (used in owner-facing UI). */
  senderName?: string | null;
}

export interface HoldMessageResult {
  /** Internal pending_messages.id (UUID). */
  pendingId: string;
  /** Whether this hold minted a new pairing code (true on first hold per peer). */
  newCode: boolean;
  /** The active code for this peer (existing or newly minted). */
  code: string;
  /** Human-formatted code (XXXX-XXXX) for owner-facing display. */
  codeShown: string;
  /** ISO timestamp for `expires_at` of this hold. */
  expiresAt: string;
}

export interface RedeemResult {
  ok: boolean;
  error?: 'unknown-code' | 'expired' | 'already-redeemed' | 'db-missing';
  /** When ok: the channel type and account/peer the code resolved to. */
  channelType?: string;
  accountKey?: string;
  peerId?: string;
  /** When ok: held messages, in arrival order, ready to be re-dispatched. */
  replayed?: Array<{
    id: string;
    payload: HoldMessagePayload;
    receivedAt: string;
  }>;
}

function nowIso(): string {
  return new Date().toISOString();
}

function expiresAtIso(): string {
  return new Date(Date.now() + PAIRING_HOLD_TTL_MS).toISOString();
}

/**
 * Delete expired rows from `pending_messages` + `pairing_codes`. Best-effort:
 * swallows errors when the tables don't exist (older test DBs that skip
 * migration 106). Returns the count of rows removed across both tables.
 */
export function sweepExpired(db: Database.Database | null | undefined): number {
  if (!db) return 0;
  try {
    const now = nowIso();
    const a = db.prepare(`DELETE FROM pending_messages WHERE expires_at < ?`).run(now);
    const b = db.prepare(`DELETE FROM pairing_codes WHERE expires_at < ? AND redeemed_at IS NULL`).run(now);
    return Number(a.changes) + Number(b.changes);
  } catch {
    return 0;
  }
}

/**
 * Persist a stranger's DM for later redemption + return the active pairing
 * code for the peer. The FIRST hold per (channel, account, peer) mints a
 * new code; subsequent holds append to the queue and reuse the existing
 * (non-redeemed, non-expired) code so the stranger isn't bombarded with
 * a new code on every reply.
 *
 * Caller is responsible for surfacing `codeShown` back to the stranger only
 * when `newCode === true` (router avoids the spam loop on retries).
 *
 * Throws when `db` is null — callers using this in router paths should have
 * a DB; tests that drive it without a DB should use the stub at the call site.
 */
export function holdMessageForPairing(
  db: Database.Database,
  channelType: string,
  accountKey: string,
  peerId: string,
  payload: HoldMessagePayload,
): HoldMessageResult {
  // Step 1: opportunistic sweep so the queue doesn't grow without bound.
  sweepExpired(db);

  const now = nowIso();
  const expiresAt = expiresAtIso();
  const pendingId = randomUUID();

  // Step 2: insert the held message.
  db.prepare(
    `INSERT INTO pending_messages
        (id, channel_type, account_key, peer_id, payload_json, received_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(pendingId, channelType, accountKey, peerId, JSON.stringify(payload), now, expiresAt);

  // Step 3: reuse an existing live code for this peer if one exists.
  const existing = db
    .prepare(
      `SELECT code FROM pairing_codes
         WHERE channel_type = ? AND account_key = ? AND peer_id = ?
           AND redeemed_at IS NULL AND expires_at > ?
         ORDER BY created_at DESC LIMIT 1`,
    )
    .get(channelType, accountKey, peerId, now) as { code: string } | undefined;

  if (existing) {
    return {
      pendingId,
      newCode: false,
      code: existing.code,
      codeShown: formatCode(existing.code),
      expiresAt,
    };
  }

  // Step 4: mint a new code. Collisions are astronomically unlikely but
  // retry a few times rather than crashing on UNIQUE violation.
  let code = '';
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = generatePairingCode();
    const normalized = normalizePairingCode(candidate);
    const hit = db.prepare(`SELECT 1 FROM pairing_codes WHERE code = ?`).get(normalized);
    if (!hit) {
      code = normalized;
      break;
    }
  }
  if (!code) {
    throw new Error('holdMessageForPairing: failed to mint a unique pairing code after 5 attempts');
  }

  db.prepare(
    `INSERT INTO pairing_codes
        (code, channel_type, account_key, peer_id, target_agent_id, created_at, expires_at, redeemed_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?, NULL)`,
  ).run(code, channelType, accountKey, peerId, now, expiresAt);

  return {
    pendingId,
    newCode: true,
    code,
    codeShown: formatCode(code),
    expiresAt,
  };
}

/** Re-insert the dash for owner-facing display (input may be normalized). */
function formatCode(normalized: string): string {
  if (normalized.length !== 8) return normalized;
  return `${normalized.slice(0, 4)}-${normalized.slice(4)}`;
}

/**
 * Owner-side redemption. Marks the code redeemed, registers the stranger
 * in `users` + `user_roles` (`role='paired'`, optionally scoped to
 * `target_agent_id`), and returns the queued messages so the router /
 * caller can re-dispatch them. Held messages are deleted in the same
 * transaction so we never replay them twice.
 */
export function redeemPairingCode(
  db: Database.Database | null | undefined,
  rawCode: string,
  ownerUserId: string,
  targetAgentId?: string | null,
): RedeemResult {
  if (!db) return { ok: false, error: 'db-missing' };
  const code = normalizePairingCode(rawCode);

  // Opportunistic sweep so an expired code surfaces as 'expired' rather
  // than 'unknown-code' in the (very rare) race where the sweeper hasn't
  // run yet.
  sweepExpired(db);

  const row = db
    .prepare(
      `SELECT code, channel_type, account_key, peer_id, target_agent_id,
              expires_at, redeemed_at
         FROM pairing_codes WHERE code = ?`,
    )
    .get(code) as
    | {
        code: string;
        channel_type: string;
        account_key: string;
        peer_id: string;
        target_agent_id: string | null;
        expires_at: string;
        redeemed_at: string | null;
      }
    | undefined;

  if (!row) return { ok: false, error: 'unknown-code' };
  if (row.redeemed_at) return { ok: false, error: 'already-redeemed' };
  if (row.expires_at < nowIso()) return { ok: false, error: 'expired' };

  const channelType = row.channel_type;
  const accountKey = row.account_key;
  const peerId = row.peer_id;
  const effectiveAgentId = targetAgentId ?? row.target_agent_id ?? null;
  const userId = `${channelType}:${peerId}`;
  const now = nowIso();

  // Run the writes inside a transaction so partial failures don't leave
  // the code redeemed but the messages un-replayed (or vice versa).
  const tx = db.transaction(() => {
    // Mark redeemed.
    db.prepare(`UPDATE pairing_codes SET redeemed_at = ? WHERE code = ?`).run(now, code);

    // Ensure the owner row exists (for the granted_by FK).
    db.prepare(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
       VALUES (?, 'real', ?, ?)`,
    ).run(ownerUserId, ownerUserId, now);

    // Ensure the paired user exists.
    db.prepare(
      `INSERT OR IGNORE INTO users (id, kind, display_name, created_at)
       VALUES (?, 'real', NULL, ?)`,
    ).run(userId, now);

    // user_roles primary key is (user_id, role, agent_group_id), so an
    // INSERT OR IGNORE is the right idempotency primitive here.
    db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
       VALUES (?, 'paired', ?, ?, ?)`,
    ).run(userId, effectiveAgentId, ownerUserId, now);

    // Pull held messages for replay, then delete them.
    const held = db
      .prepare(
        `SELECT id, payload_json, received_at FROM pending_messages
           WHERE channel_type = ? AND account_key = ? AND peer_id = ?
           ORDER BY received_at ASC, id ASC`,
      )
      .all(channelType, accountKey, peerId) as Array<{
      id: string;
      payload_json: string;
      received_at: string;
    }>;

    db.prepare(`DELETE FROM pending_messages WHERE channel_type = ? AND account_key = ? AND peer_id = ?`).run(
      channelType,
      accountKey,
      peerId,
    );

    return held;
  });

  let held: Array<{ id: string; payload_json: string; received_at: string }>;
  try {
    held = tx();
  } catch (err) {
    log.error('redeemPairingCode tx failed', { err: (err as Error)?.message ?? String(err) });
    return { ok: false, error: 'unknown-code' };
  }

  // Opportunistic sweep on success too (caller may not run periodically).
  sweepExpired(db);

  const replayed = held.map((h) => {
    let payload: HoldMessagePayload = { text: '' };
    try {
      payload = JSON.parse(h.payload_json) as HoldMessagePayload;
    } catch {
      /* shouldn't happen — we wrote it ourselves */
    }
    return { id: h.id, payload, receivedAt: h.received_at };
  });

  return {
    ok: true,
    channelType,
    accountKey,
    peerId,
    replayed,
  };
}

/**
 * Owner-side revoke: delete an outstanding pairing code (and any held
 * messages for that peer) before the stranger gets approved. Used when
 * the owner wants to cancel a pending invite (spam, mistake, expired
 * intent).
 *
 * Semantics:
 *   - unknown code → { ok: false, error: 'unknown-code' }
 *   - already-redeemed → { ok: false, error: 'already-redeemed' }
 *     (no-op: the user_roles row is preserved; revoking after pairing
 *     is a different surface, not this one)
 *   - happy path → deletes the code row + matching pending_messages,
 *     returns peerId + count removed
 */
export function revokePairingCode(
  db: Database.Database | null | undefined,
  rawCode: string,
): { ok: boolean; error?: string; peerId?: string; channelType?: string; accountKey?: string; removed?: number } {
  if (!db) return { ok: false, error: 'db-missing' };
  const code = normalizePairingCode(rawCode);
  try {
    const row = db
      .prepare(
        `SELECT code, channel_type, account_key, peer_id, redeemed_at
           FROM pairing_codes WHERE code = ?`,
      )
      .get(code) as
      | { code: string; channel_type: string; account_key: string; peer_id: string; redeemed_at: string | null }
      | undefined;
    if (!row) return { ok: false, error: 'unknown-code' };
    if (row.redeemed_at) return { ok: false, error: 'already-redeemed' };
    const tx = db.transaction(() => {
      const del = db
        .prepare(`DELETE FROM pending_messages WHERE channel_type = ? AND account_key = ? AND peer_id = ?`)
        .run(row.channel_type, row.account_key, row.peer_id);
      db.prepare(`DELETE FROM pairing_codes WHERE code = ?`).run(code);
      return Number(del.changes ?? 0);
    });
    const removed = tx();
    return {
      ok: true,
      peerId: row.peer_id,
      channelType: row.channel_type,
      accountKey: row.account_key,
      removed,
    };
  } catch (err) {
    log.error('revokePairingCode failed', { err: (err as Error)?.message ?? String(err) });
    return { ok: false, error: 'unknown' };
  }
}

/** List unredeemed, unexpired pairing codes — powers `/pair-pending`. */
export function listPendingPairings(db: Database.Database | null | undefined): Array<{
  code: string;
  channelType: string;
  accountKey: string;
  peerId: string;
  createdAt: string;
  expiresAt: string;
  messageCount: number;
}> {
  if (!db) return [];
  try {
    sweepExpired(db);
    const rows = db
      .prepare(
        `SELECT c.code AS code, c.channel_type AS channel_type, c.account_key AS account_key,
                c.peer_id AS peer_id, c.created_at AS created_at, c.expires_at AS expires_at,
                (SELECT COUNT(*) FROM pending_messages p
                   WHERE p.channel_type = c.channel_type
                     AND p.account_key  = c.account_key
                     AND p.peer_id      = c.peer_id) AS message_count
           FROM pairing_codes c
          WHERE c.redeemed_at IS NULL
            AND c.expires_at > ?
          ORDER BY c.created_at ASC`,
      )
      .all(nowIso()) as Array<{
      code: string;
      channel_type: string;
      account_key: string;
      peer_id: string;
      created_at: string;
      expires_at: string;
      message_count: number;
    }>;
    return rows.map((r) => ({
      code: r.code,
      channelType: r.channel_type,
      accountKey: r.account_key,
      peerId: r.peer_id,
      createdAt: r.created_at,
      expiresAt: r.expires_at,
      messageCount: Number(r.message_count),
    }));
  } catch {
    return [];
  }
}
