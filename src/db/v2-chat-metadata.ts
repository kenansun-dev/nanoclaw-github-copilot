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
  trigger_rules: string | null;
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
  // engage_mode='always' ⇒ no trigger required (was requiresTrigger=false).
  const trigger = mga?.engage_pattern ?? mga?.trigger_rules ?? '';
  const requiresTrigger = mga?.engage_mode != null ? mga.engage_mode !== 'always' : undefined;
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
      `SELECT messaging_group_id, trigger_rules, engage_mode, engage_pattern, agent_group_id
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
      `SELECT messaging_group_id, trigger_rules, engage_mode, engage_pattern, agent_group_id
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

/** Phase 1 dual-read warn helper. Called from db.ts facade reads when
 *  `process.env.NANOCLAW_CHAT_METADATA_DUAL_READ !== '0'`. Logs a single
 *  aggregate warn line per call (not per-row) to keep noise floor low. */
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
    'chat-metadata v1↔v2 drift detected (Phase 1 dual-read)',
  );
}
