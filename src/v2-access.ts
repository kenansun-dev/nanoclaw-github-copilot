/**
 * v2 access gating + pairing hold/redemption — fixup #49 steps 6 + 7.
 *
 * Replaces the legacy `chats[jid].agentId` + ad-hoc allowlist gates with a
 * config-driven check based on `channels.<proto>.accounts.<accountKey>` and
 * its `dmPolicy` / `allowFrom` / `groupPolicy` / `groupAllowFrom` / `groups`
 * fields (see docs/proposals/2026-05-12-config-shape-v2.md).
 *
 * Called from `routeInbound` BEFORE agent fan-out. Three possible decisions:
 *
 *   - `'allow'`         — continue to agent dispatch
 *   - `'deny'`          — drop silently (audit row recorded by caller)
 *   - `'hold-pairing'`  — strangers in `dmPolicy='pairing'` accounts; the
 *                         hold-and-replay flow lives in `holdMessageForPairing`
 *                         and `redeemPairingCode` below (step 7).
 *
 * Owner override: any user with a `user_roles` row of role='owner' bypasses
 * all checks. Looked up by the namespaced id `<channelType>:<rawSenderId>`.
 *
 * Legacy compat: if the channel has no `accounts` map (pre-v2 config), the
 * check is permissive (`allow`). This keeps existing router tests green
 * until per-channel account configs are populated; new code should set
 * `accounts.<key>` explicitly.
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import type { AccountAccessConfig, AccountGroupEntry, NanoclawConfig } from './config-loader.js';
import { log } from './log.js';
import { generatePairingCode, normalizePairingCode } from './pairing/code.js';

export type AccessAction = 'allow' | 'deny' | 'hold-pairing';

export interface AccessCheckResult {
  action: AccessAction;
  reason?: string;
}

export interface InboundAccessInput {
  /** Channel type, e.g. 'telegram' / 'discord' / 'teams'. */
  channelType: string;
  /**
   * Bot account key. Defaults to 'default' when unset (per-account routing
   * not yet wired through all adapters).
   */
  accountKey?: string;
  /** Group/chat platform id (raw, no channel prefix). */
  platformId: string;
  /** True if this is a group chat, false for DM. */
  isGroup: boolean;
  /** Raw sender id (no channel prefix), or null if unknown. */
  senderRawId: string | null;
  /** Bot-mention signal from the adapter. */
  isMention: boolean;
  /** Best-effort text body (for trigger-word checks; currently unused). */
  text: string;
}

const DEFAULT_DM_POLICY: 'pairing' | 'open' | 'strict' = 'pairing';
const DEFAULT_GROUP_POLICY: 'strict' | 'open' | 'allowlist' = 'strict';
const DEFAULT_REQUIRE_MENTION = true;

/** Map channel type → config.channels key. Currently a passthrough. */
function protoToChannelKey(channelType: string): string {
  return channelType === 'tg' ? 'telegram' : channelType;
}

/**
 * Resolve the account config for a channel + accountKey. Returns
 * `undefined` when the channel has no `accounts` map at all (legacy
 * config — caller treats as permissive). Returns an empty object when the
 * accounts map exists but doesn't contain this key — that's a "use default
 * v2 semantics" signal, not a legacy bypass.
 */
function resolveAccount(
  config: NanoclawConfig,
  channelType: string,
  accountKey: string,
): AccountAccessConfig | undefined {
  const chKey = protoToChannelKey(channelType);
  const ch = config.channels?.[chKey] as { accounts?: Record<string, AccountAccessConfig> } | undefined;
  if (!ch || !ch.accounts) return undefined;
  // Specific key, then 'default', then first available — but only if at
  // least one account exists (otherwise treat as legacy).
  if (ch.accounts[accountKey]) return ch.accounts[accountKey];
  if (ch.accounts['default']) return ch.accounts['default'];
  const first = Object.values(ch.accounts)[0];
  return first ?? {};
}

/** Check if a sender id is registered as global owner. */
function isOwner(db: Database.Database | null | undefined, channelType: string, senderRawId: string | null): boolean {
  if (!db || !senderRawId) return false;
  try {
    const userId = `${channelType}:${senderRawId}`;
    const row = db
      .prepare(`SELECT 1 AS hit FROM user_roles WHERE user_id = ? AND role = 'owner' LIMIT 1`)
      .get(userId) as { hit: number } | undefined;
    return !!row;
  } catch {
    // Table missing (pre-v2 schema): no owners, no bypass.
    return false;
  }
}

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

    db.prepare(
      `DELETE FROM pending_messages WHERE channel_type = ? AND account_key = ? AND peer_id = ?`,
    ).run(channelType, accountKey, peerId);

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

/** List unredeemed, unexpired pairing codes — powers `/pair-pending`. */
export function listPendingPairings(
  db: Database.Database | null | undefined,
): Array<{
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


/**
 * Decide whether an inbound message is allowed past the access gate.
 *
 * Cascade rules (DM):
 *   1. owner role → allow
 *   2. sender in `account.allowFrom` → allow
 *   3. `dmPolicy='open'` → allow
 *   4. `dmPolicy='strict'` → deny
 *   5. default (`'pairing'` / unset) → hold-pairing
 *
 * Cascade rules (group):
 *   1. owner role → allow
 *   2. group config = `groups[groupId]` ?? `groups['*']`
 *   3. allowFrom cascade: group.allowFrom → account.groupAllowFrom → account.allowFrom
 *      - sender in cascade → allowed (subject to mention check)
 *   4. else `groupPolicy='open'` → allowed (subject to mention check)
 *      `groupPolicy='strict'` (default) → deny
 *   5. mention check: if `requireMention` (default true) and !isMention
 *      and no trigger word → deny
 */
export function checkInboundAccess(
  config: NanoclawConfig,
  db: Database.Database | null | undefined,
  inbound: InboundAccessInput,
): AccessCheckResult {
  const accountKey = inbound.accountKey || 'default';

  // Owner bypass (independent of account config).
  if (isOwner(db, inbound.channelType, inbound.senderRawId)) {
    return { action: 'allow' };
  }

  const account = resolveAccount(config, inbound.channelType, accountKey);

  // Legacy compat: no `accounts` map at all → permissive (preserves
  // pre-v2 router behaviour during the migration window).
  if (account === undefined) {
    return { action: 'allow' };
  }

  // Opt-in: only enforce gating when the account explicitly declares at
  // least one v2 access-control field. An account that only carries
  // credentials (auto-normalized `accounts.default = { botToken }`) is
  // treated the same as legacy — the channel-request / sender-approval
  // modules continue to own access decisions.
  const hasV2Fields =
    account.dmPolicy !== undefined ||
    account.allowFrom !== undefined ||
    account.groupPolicy !== undefined ||
    account.groupAllowFrom !== undefined ||
    account.groups !== undefined;
  if (!hasV2Fields) {
    return { action: 'allow' };
  }

  const senderId = inbound.senderRawId;

  if (!inbound.isGroup) {
    // ── DM branch ──
    const allowFrom = account.allowFrom ?? [];
    if (senderId && allowFrom.includes(senderId)) {
      return { action: 'allow' };
    }
    const policy = account.dmPolicy ?? DEFAULT_DM_POLICY;
    if (policy === 'open') return { action: 'allow' };
    if (policy === 'strict') return { action: 'deny', reason: 'dm-strict-not-in-allowFrom' };
    // 'pairing' (default)
    return { action: 'hold-pairing', reason: 'dm-pairing' };
  }

  // ── Group branch ──
  const groupsMap = account.groups ?? {};
  // Specific id overrides '*' wildcard.
  const groupCfg: AccountGroupEntry | undefined = groupsMap[inbound.platformId] ?? groupsMap['*'];

  // allowFrom cascade
  const groupAllowFrom = groupCfg?.allowFrom;
  const acctGroupAllowFrom = account.groupAllowFrom;
  const acctAllowFrom = account.allowFrom;

  let allowed = false;
  if (groupAllowFrom !== undefined) {
    if (senderId && groupAllowFrom.includes(senderId)) allowed = true;
  } else if (acctGroupAllowFrom !== undefined) {
    if (senderId && acctGroupAllowFrom.includes(senderId)) allowed = true;
  } else if (acctAllowFrom !== undefined) {
    if (senderId && acctAllowFrom.includes(senderId)) allowed = true;
  }

  if (!allowed) {
    const gp = account.groupPolicy ?? DEFAULT_GROUP_POLICY;
    if (gp === 'open') {
      allowed = true;
    } else {
      return { action: 'deny', reason: 'group-not-in-allowFrom' };
    }
  }

  // Allowed — apply requireMention from group config (default true).
  const requireMention = groupCfg?.requireMention ?? DEFAULT_REQUIRE_MENTION;
  if (requireMention && !inbound.isMention) {
    log.debug(
      'v2-access deny: requireMention-not-satisfied — tip: set group.requireMention=false to allow non-mention messages',
      {
        channelType: inbound.channelType,
        platformId: inbound.platformId,
        groupPolicy: account.groupPolicy ?? DEFAULT_GROUP_POLICY,
      },
    );
    return { action: 'deny', reason: 'requireMention-not-satisfied' };
  }

  return { action: 'allow' };
}
