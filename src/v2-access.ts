/**
 * v2 access gating — fixup #49 step 6.
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
 *                         actual hold-and-card flow lands in step 7. For
 *                         now `holdMessageForPairing` is a console.warn
 *                         stub so we can wire the call site and tests.
 *
 * Owner override: any user with a `user_roles` row of role='owner' bypasses
 * all checks. Looked up by the namespaced id `<channelType>:<rawSenderId>`.
 *
 * Legacy compat: if the channel has no `accounts` map (pre-v2 config), the
 * check is permissive (`allow`). This keeps existing router tests green
 * until per-channel account configs are populated; new code should set
 * `accounts.<key>` explicitly.
 */

import type Database from 'better-sqlite3';

import type {
  AccountAccessConfig,
  AccountGroupEntry,
  NanoclawConfig,
} from './config-loader.js';
import { log } from './log.js';

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
function isOwner(
  db: Database.Database | null | undefined,
  channelType: string,
  senderRawId: string | null,
): boolean {
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
 * Stub for step 7: persist the message for pairing-code redemption. For
 * now just logs so the call site is wired and tests can spy on it.
 */
export function holdMessageForPairing(
  channelType: string,
  accountKey: string,
  peerId: string,
  text: string,
): void {
  log.warn('holdMessageForPairing (step-6 stub — step 7 will persist)', {
    channelType,
    accountKey,
    peerId,
    textLen: text.length,
  });
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
  const groupCfg: AccountGroupEntry | undefined =
    groupsMap[inbound.platformId] ?? groupsMap['*'];

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
    return { action: 'deny', reason: 'requireMention-not-satisfied' };
  }

  return { action: 'allow' };
}
