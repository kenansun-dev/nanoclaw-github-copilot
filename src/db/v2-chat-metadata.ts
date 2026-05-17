/**
 * v2 chat metadata bridge — v1 `registered_groups` ↔ v2 `messaging_groups`.
 *
 * Phase 1 of the chat-metadata cutover (proposal:
 * `docs/proposals/2026-05-16-chat-metadata-via-mg-mga.md`).
 *
 * Provides a v2-backed read API that returns the same shape as the
 * legacy `getRegisteredGroup` / `getAllRegisteredGroups` callers expect,
 * so the cutover can flip read primacy in Phase 2 with zero call-site
 * churn. In Phase 1 the v1 readers in `db.ts` are the source of truth;
 * the v2 reads here run alongside in dual-read mode so doctor + the
 * facade can surface drift before flipping.
 *
 * Field gaps vs v1:
 *   - `containerConfig` — owner approved drop (Q1, 2026-05-16);
 *     never returned from v2 and never re-added.
 *   - `is_main` — already retired (PR #49 isMain cutover, see
 *     `v2-default-agent.ts`).
 *
 * Key bridging: `synthLegacyJid` from `channel-key.ts` maps the v2
 * (channel_type, platform_id) tuple back to a v1-shaped jid so caller
 * lookups by jid still work. F1 fix from VM live-DB review verified
 * naive `channel_type || ':' || platform_id` would 100%-miss Telegram.
 */

import { getDb } from './connection.js';
import { logger } from '../log-extensions.js';
import { jidToTypeAndPlatformId, synthLegacyJid } from './channel-key.js';
import {
  createMessagingGroup,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
  deleteMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  updateMessagingGroupAgent,
  deleteMessagingGroupAgent,
} from './messaging-groups.js';
import { createAgentGroup, getAgentGroupByFolder } from './agent-groups.js';
import type { RegisteredGroup } from '../types-extensions.js';

interface MgRow {
  id: string;
  channel_type: string;
  platform_id: string;
  name: string | null;
  created_at: string;
}

interface MgaRow {
  messaging_group_id: string;
  // engage-modes columns (migration 010)
  engage_mode: string | null;
  engage_pattern: string | null;
}

interface BridgedRow {
  jid: string;
  name: string;
  trigger: string;
  added_at: string;
  requiresTrigger: boolean | undefined;
}

function mgWithMgaToBridged(mg: MgRow, mga: MgaRow | null): BridgedRow {
  // engage_pattern is the v2 equivalent of v1 trigger_pattern.
  // The "always engage" flavor is encoded as engage_mode='pattern'
  // + engage_pattern='.' (matches everything) per migration 010.
  const trigger = mga?.engage_pattern ?? '';
  let requiresTrigger: boolean | undefined;
  if (mga?.engage_mode != null) {
    const isAlways = mga.engage_mode === 'pattern' && mga.engage_pattern === '.';
    requiresTrigger = !isAlways;
  }
  return {
    jid: synthLegacyJid(mg.channel_type, mg.platform_id),
    name: mg.name ?? '',
    trigger,
    added_at: mg.created_at,
    requiresTrigger,
  };
}

/** Look up one MG by v1-shaped jid. Returns the v1-shaped row + folder
 *  comes from `agent_groups.id` via the MGA join (or undefined when the
 *  chat isn't wired to an agent yet). */
export function getRegisteredGroupV2(jid: string): (BridgedRow & { folder: string }) | undefined {
  const decoded = jidToTypeAndPlatformId(jid);
  if (!decoded) return undefined;
  const mg = getDb()
    .prepare(
      `SELECT id, channel_type, platform_id, name, created_at
         FROM messaging_groups
        WHERE channel_type = ? AND platform_id = ?
        LIMIT 1`,
    )
    .get(decoded.channelType, decoded.platformId) as MgRow | undefined;
  if (!mg) return undefined;

  const mga = getDb()
    .prepare(
      `SELECT messaging_group_id, engage_mode, engage_pattern, agent_group_id
         FROM messaging_group_agents
        WHERE messaging_group_id = ?
        LIMIT 1`,
    )
    .get(mg.id) as (MgaRow & { agent_group_id: string }) | undefined;

  const bridged = mgWithMgaToBridged(mg, mga ?? null);
  return { ...bridged, folder: mga?.agent_group_id ?? '' };
}

/** Read all v2 chat metadata as a jid-keyed map (same shape as
 *  `getAllRegisteredGroups`). Drops rows that fail to bridge (no MGA). */
export function getAllRegisteredGroupsV2(): Record<string, BridgedRow & { folder: string }> {
  const mgs = getDb()
    .prepare(`SELECT id, channel_type, platform_id, name, created_at FROM messaging_groups`)
    .all() as MgRow[];
  if (mgs.length === 0) return {};

  const mgaRows = getDb()
    .prepare(
      `SELECT messaging_group_id, engage_mode, engage_pattern, agent_group_id
         FROM messaging_group_agents`,
    )
    .all() as Array<MgaRow & { agent_group_id: string }>;
  const mgaByGroup = new Map<string, MgaRow & { agent_group_id: string }>();
  for (const m of mgaRows) mgaByGroup.set(m.messaging_group_id, m);

  const out: Record<string, BridgedRow & { folder: string }> = {};
  for (const mg of mgs) {
    const mga = mgaByGroup.get(mg.id);
    if (!mga) continue; // unwired MGs aren't part of legacy `registered_groups`
    const bridged = mgWithMgaToBridged(mg, mga);
    out[bridged.jid] = { ...bridged, folder: mga.agent_group_id };
  }
  return out;
}

/** Compare v1 and v2 read results and return the per-jid drift count.
 *  Used by doctor (F4 follow-up) to surface inconsistencies before
 *  Phase 2 flips read primacy. */
export interface ChatMetadataDrift {
  v1OnlyJids: string[];
  v2OnlyJids: string[];
  fieldMismatchJids: string[];
}

export function compareV1V2ChatMetadata(
  v1: Record<string, RegisteredGroup>,
  v2: Record<string, BridgedRow & { folder: string }>,
): ChatMetadataDrift {
  const v1Jids = new Set(Object.keys(v1));
  const v2Jids = new Set(Object.keys(v2));
  const v1Only: string[] = [];
  const v2Only: string[] = [];
  const mismatch: string[] = [];

  for (const jid of v1Jids) {
    if (!v2Jids.has(jid)) {
      v1Only.push(jid);
      continue;
    }
    const a = v1[jid];
    const b = v2[jid];
    if (a.folder !== b.folder || a.name !== b.name) mismatch.push(jid);
  }
  for (const jid of v2Jids) {
    if (!v1Jids.has(jid)) v2Only.push(jid);
  }
  return { v1OnlyJids: v1Only, v2OnlyJids: v2Only, fieldMismatchJids: mismatch };
}

/** Phase 1 dual-read warn helper. Retained for the doctor drift check
 *  in deployments still on the dual-read code path; new code should not
 *  call this. Cutover (2026-05-16) flipped the db.ts facade to v2-only
 *  reads/writes, so live traffic no longer triggers this. */
export function warnOnChatMetadataDrift(
  v1: Record<string, RegisteredGroup>,
  v2: Record<string, BridgedRow & { folder: string }>,
  caller: string,
): void {
  const drift = compareV1V2ChatMetadata(v1, v2);
  if (drift.v1OnlyJids.length === 0 && drift.v2OnlyJids.length === 0 && drift.fieldMismatchJids.length === 0) {
    return;
  }
  logger.warn(
    {
      caller,
      v1Only: drift.v1OnlyJids.length,
      v2Only: drift.v2OnlyJids.length,
      mismatch: drift.fieldMismatchJids.length,
      sampleV1Only: drift.v1OnlyJids.slice(0, 3),
      sampleV2Only: drift.v2OnlyJids.slice(0, 3),
      sampleMismatch: drift.fieldMismatchJids.slice(0, 3),
    },
    'chat-metadata v1↔v2 drift detected',
  );
}

// ── Write API (cutover 2026-05-16) ──
//
// These mirror the v1 `setRegisteredGroup` / `removeRegisteredGroup`
// surface but write into MG + MGA only. Used by the db.ts facade
// after the v1-write path was retired.

/** Map v1 `requiresTrigger` flag to v2 `engage_mode` + `engage_pattern`.
 *  - true (default for groups)  → 'mention-sticky' / null    (must @mention)
 *  - false (default for solo)   → 'pattern' / '.'             (always engage)
 *  - undefined                  → default to 'mention-sticky'
 *  Encoding mirrors migration 010-engage-modes.ts. */
function requiresTriggerToEngageFields(
  requiresTrigger: boolean | undefined,
  triggerPattern: string,
): { engage_mode: 'pattern' | 'mention' | 'mention-sticky'; engage_pattern: string | null } {
  if (requiresTrigger === false) {
    return { engage_mode: 'pattern', engage_pattern: '.' };
  }
  // requiresTrigger is true or undefined → needs an explicit trigger.
  // Use 'mention-sticky' as the v1-equivalent of "@mention engages, then
  // sticky for the rest of the conversation". The v1 trigger pattern (if
  // provided) is preserved in engage_pattern for diagnostics; engage_mode
  // is the source of truth.
  return { engage_mode: 'mention-sticky', engage_pattern: triggerPattern || null };
}

/** Idempotent upsert of the MG + MGA pair for a v1 `RegisteredGroup`.
 *  Ensures the `agent_groups` row exists for `group.folder` first, since
 *  MGA.agent_group_id has a FK to it (see migrations/001-initial.ts:32). */
export function setRegisteredGroupV2(jid: string, group: RegisteredGroup & { jid?: string }): void {
  const decoded = jidToTypeAndPlatformId(jid);
  if (!decoded) {
    throw new Error(`setRegisteredGroupV2: cannot decode jid ${jid}`);
  }
  const now = new Date().toISOString();

  // 1. Ensure agent_groups row exists for the folder (FK target). New
  //    chats created via `addChat` may invent a folder before the
  //    config→agent_groups reconcile runs; we mirror reconcile's id
  //    convention (id == folder) so the rows converge.
  let ag = getAgentGroupByFolder(group.folder);
  if (!ag) {
    createAgentGroup({
      id: group.folder,
      name: group.folder,
      folder: group.folder,
      agent_provider: null,
      created_at: now,
    });
    ag = getAgentGroupByFolder(group.folder)!;
  }

  // 2. Upsert the messaging_group row.
  let mg = getMessagingGroupByPlatform(decoded.channelType, decoded.platformId);
  if (!mg) {
    const mgId = `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    createMessagingGroup({
      id: mgId,
      channel_type: decoded.channelType,
      platform_id: decoded.platformId,
      name: group.name,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now,
    });
    mg = getMessagingGroupByPlatform(decoded.channelType, decoded.platformId)!;
  } else if (mg.name !== group.name) {
    updateMessagingGroup(mg.id, { name: group.name });
  }

  // 3. Upsert the messaging_group_agents wiring.
  const { engage_mode: engageMode, engage_pattern: engagePattern } = requiresTriggerToEngageFields(
    group.requiresTrigger,
    group.trigger,
  );
  const existingMga = getMessagingGroupAgentByPair(mg.id, ag.id);
  if (!existingMga) {
    createMessagingGroupAgent({
      id: `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      engage_mode: engageMode,
      engage_pattern: engagePattern,
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
  } else {
    updateMessagingGroupAgent(existingMga.id, {
      engage_mode: engageMode,
      engage_pattern: engagePattern,
    });
  }
}

/** Symmetric to `setRegisteredGroupV2`. Removes the MGA wiring for the
 *  jid; if no other MGAs reference the MG, removes the MG too.
 *  Returns true when at least one row was deleted. */
export function removeRegisteredGroupV2(jid: string): boolean {
  const decoded = jidToTypeAndPlatformId(jid);
  if (!decoded) return false;
  const mg = getMessagingGroupByPlatform(decoded.channelType, decoded.platformId);
  if (!mg) return false;

  const mgas = getMessagingGroupAgents(mg.id);
  for (const mga of mgas) deleteMessagingGroupAgent(mga.id);
  deleteMessagingGroup(mg.id);
  return mgas.length > 0 || true;
}
