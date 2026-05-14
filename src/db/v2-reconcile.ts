/**
 * v2 config-shape reconcile pipeline.
 *
 * `reconcileConfigToDb(config, db)` is the bridge from declared config
 * (nanoclaw.json) to runtime DB state (v2 tables). Idempotent and
 * transactional: failure rolls back, re-run finds the same end state.
 *
 * Scope (post step 1+2 RBAC cutover):
 *
 *   1. agents.list[]                  → agent_groups
 *   2. accounts.*.allowFrom           → users + agent_group_members on
 *                                       every live agent_group ("普通 user
 *                                       can chat with agents").
 *   3. channels.<type>.roleBindings   → user_roles (full overwrite).
 *                                       owner / admin both global
 *                                       (agent_group_id IS NULL) for now.
 *   4. bindings[]                     → messaging_group_agents (only when
 *                                       `match.peer.id` is set AND the
 *                                       messaging_groups row already
 *                                       exists; wildcards skipped — those
 *                                       stay router-time).
 *   5. accounts.*.groups.*.requireMention
 *                                     → projects to engage_mode/engage_pattern
 *                                       on every existing
 *                                       `messaging_group_agents` row whose
 *                                       messaging_group matches (channel,
 *                                       peerId, is_group=1).
 *
 * Deprecation paths (auto-migrated, one warn per boot):
 *
 *   - `commands.ownerAllowFrom: string[]`  →  channel-qualified ids
 *     (`<channelType>:<rawId>`) get split back into
 *     `channels.<channelType>.roleBindings[<rawId>] = 'owner'`.
 *   - `accounts.*.groupAllowFrom: string[]` → entries get appended into
 *     the same account's `allowFrom`.
 *
 * Explicitly NOT in scope (lazy / grows on demand):
 *
 *   - messaging_groups: populated on first inbound message per chat
 *     (router work — later commit in this branch).
 *
 * agent_groups removal: agents listed only in DB but not in config are
 * **archived** rather than deleted, to protect FK references from
 * `sessions` / `scheduled_tasks`. Archival is recorded in the dedicated
 * `archived_at` column (migration 107). Re-declaration of a previously
 * archived agent clears `archived_at` back to NULL.
 */
import type Database from 'better-sqlite3';

import type { NanoclawConfig } from '../config-loader.js';
import { log } from '../log.js';

interface ReconcileSummary {
  agentGroups: { inserted: string[]; archived: string[]; updated: string[] };
  users: { inserted: string[] };
  userRoles: { inserted: string[]; deleted: string[] };
  agentGroupMembers: { inserted: number };
  messagingGroupAgents: { updated: number; inserted: number };
}

// One-shot deprecation flags (per boot / per process).
let warnedDeprecatedOwnerAllowFrom = false;
let warnedDeprecatedGroupAllowFrom = false;

/** Test-only: reset deprecation warning flags between cases. */
export function __resetDeprecationWarningsForTests(): void {
  warnedDeprecatedOwnerAllowFrom = false;
  warnedDeprecatedGroupAllowFrom = false;
}

function nowIso(): string {
  return new Date().toISOString();
}

function channelKeyToType(channelKey: string): string {
  switch (channelKey) {
    case 'telegram':
    case 'teams':
    case 'discord':
    case 'whatsapp':
    case 'slack':
    case 'iMessage':
    case 'email':
    case 'matrix':
      return channelKey;
    case 'tg':
      return 'telegram';
    default:
      return channelKey;
  }
}

interface MutableAccount {
  allowFrom?: string[];
  /**
   * @deprecated Auto-merged into `allowFrom` by
   * `autoMergeGroupAllowFrom` and then deleted. Kept on the type only
   * so the merge function can read+drop it; reconcile readers must not
   * reference this field.
   */
  groupAllowFrom?: string[];
  groups?: Record<string, { allowFrom?: string[]; requireMention?: boolean }>;
  [k: string]: unknown;
}

interface MutableChannel {
  enabled?: boolean;
  accounts?: Record<string, MutableAccount>;
  roleBindings?: Record<string, 'owner' | 'admin'>;
  [k: string]: unknown;
}

/**
 * Auto-merge stale `accounts.*.groupAllowFrom` entries into the same
 * account's `allowFrom`, in-place on the live config. Emits one
 * deprecation warning per boot if any merge happened.
 */
function autoMergeGroupAllowFrom(config: NanoclawConfig): void {
  let merged = false;
  const channels = (config.channels ?? {}) as Record<string, MutableChannel>;
  for (const channelDef of Object.values(channels)) {
    const accounts = channelDef?.accounts;
    if (!accounts) continue;
    for (const acc of Object.values(accounts)) {
      const stale = acc?.groupAllowFrom;
      if (!Array.isArray(stale) || stale.length === 0) continue;
      acc.allowFrom = acc.allowFrom ?? [];
      for (const v of stale) {
        if (!acc.allowFrom.includes(v)) acc.allowFrom.push(v);
      }
      // Drop the deprecated field so subsequent passes are clean.
      delete acc.groupAllowFrom;
      merged = true;
    }
  }
  if (merged && !warnedDeprecatedGroupAllowFrom) {
    warnedDeprecatedGroupAllowFrom = true;
    log.warn(
      'config: accounts.*.groupAllowFrom is deprecated; entries auto-merged into accounts.*.allowFrom. Please update nanoclaw.json.',
    );
  }
}

/**
 * Auto-merge stale `commands.ownerAllowFrom` (channel-qualified ids
 * like `telegram:8731`) into `channels.<channelType>.roleBindings`
 * as 'owner'. Emits one deprecation warning per boot if any merge
 * happened.
 */
function autoMergeOwnerAllowFrom(config: NanoclawConfig): void {
  const cmds = (config as unknown as { commands?: { ownerAllowFrom?: string[] } }).commands;
  const stale = cmds?.ownerAllowFrom;
  if (!Array.isArray(stale) || stale.length === 0) return;
  // Shallow-clone the `channels` map before any mutation. After
  // loadConfig+deepMerge, when the user config doesn't declare
  // `channels` at all the result still points at DEFAULTS.channels by
  // reference (deepMerge only recurses on keys that exist in source).
  // Mutating it in place would leak into DEFAULTS and bleed across
  // boots / tests that share the module instance.
  const cfgRoot = config as unknown as { channels?: Record<string, MutableChannel> };
  cfgRoot.channels = { ...((cfgRoot.channels ?? {}) as Record<string, MutableChannel>) };
  const channels = cfgRoot.channels;
  let merged = false;
  for (const qualified of stale) {
    const idx = qualified.indexOf(':');
    if (idx <= 0) continue;
    const channelType = qualified.slice(0, idx);
    const rawId = qualified.slice(idx + 1);
    // Clone the channel + roleBindings before mutating: after
    // loadConfig+deepMerge, channels[channelType] may still reference
    // the shared DEFAULTS object. In-place mutation would leak across
    // boots / tests sharing the same module instance.
    const existing = channels[channelType] ?? ({ enabled: false } as MutableChannel);
    const ch: MutableChannel = { ...existing, roleBindings: { ...(existing.roleBindings ?? {}) } };
    if (ch.roleBindings![rawId] !== 'owner' && ch.roleBindings![rawId] !== 'admin') {
      ch.roleBindings![rawId] = 'owner';
      merged = true;
    }
    channels[channelType] = ch;
  }
  // Drop the deprecated field from the in-memory config so downstream
  // readers see a single source of truth. Symmetric with
  // autoMergeGroupAllowFrom which deletes acc.groupAllowFrom.
  delete cmds!.ownerAllowFrom;
  if (merged && !warnedDeprecatedOwnerAllowFrom) {
    warnedDeprecatedOwnerAllowFrom = true;
    log.warn(
      'config: commands.ownerAllowFrom is deprecated; entries auto-merged into channels.<type>.roleBindings as owner. Please update nanoclaw.json.',
    );
  }
}

function collectAllowFromUsers(config: NanoclawConfig): Map<string, string> {
  // Returns `userId → channelType` for every sender referenced by any
  // `allowFrom` list anywhere under `channels.*.accounts.*`. Owner / admin
  // ids declared via `roleBindings` are folded in by the caller.
  const users = new Map<string, string>();
  const channels = (config.channels ?? {}) as Record<string, MutableChannel>;
  for (const [channelKey, channelDef] of Object.entries(channels)) {
    const channelType = channelKeyToType(channelKey);
    const accounts = channelDef?.accounts;
    if (!accounts) continue;
    for (const acc of Object.values(accounts)) {
      for (const raw of acc.allowFrom ?? []) users.set(`${channelType}:${raw}`, channelType);
      // groupAllowFrom intentionally not read here — merged into
      // allowFrom in the pre-tx autoMergeGroupAllowFrom step. Field is
      // also dropped from MutableAccount.
      for (const g of Object.values(acc.groups ?? {})) {
        for (const raw of g.allowFrom ?? []) users.set(`${channelType}:${raw}`, channelType);
      }
    }
  }
  return users;
}

interface RoleEntry {
  userId: string;
  role: 'owner' | 'admin';
  channelType: string;
}

function collectRoleBindings(config: NanoclawConfig): RoleEntry[] {
  const out: RoleEntry[] = [];
  const channels = (config.channels ?? {}) as Record<string, MutableChannel>;
  for (const [channelKey, channelDef] of Object.entries(channels)) {
    const channelType = channelKeyToType(channelKey);
    const rb = channelDef?.roleBindings;
    if (!rb || typeof rb !== 'object') continue;
    for (const [rawId, role] of Object.entries(rb)) {
      if (role !== 'owner' && role !== 'admin') continue;
      out.push({ userId: `${channelType}:${rawId}`, role, channelType });
    }
  }
  return out;
}

/**
 * Run the reconcile pipeline. All work is wrapped in a single transaction;
 * any thrown error rolls back the entire reconcile, leaving the DB in its
 * pre-call state.
 *
 * Safe to call multiple times — every step is idempotent.
 */
export function reconcileConfigToDb(config: NanoclawConfig, db: Database.Database): ReconcileSummary {
  const summary: ReconcileSummary = {
    agentGroups: { inserted: [], archived: [], updated: [] },
    users: { inserted: [] },
    userRoles: { inserted: [], deleted: [] },
    agentGroupMembers: { inserted: 0 },
    messagingGroupAgents: { updated: 0, inserted: 0 },
  };

  // ── Pre-tx: deprecation auto-merges (mutate in-memory config) ────────
  autoMergeGroupAllowFrom(config);
  autoMergeOwnerAllowFrom(config);

  const tx = db.transaction(() => {
    const now = nowIso();

    // ── 1. agent_groups from agents.list[] ─────────────────────────────
    const declaredAgents = (config.agents?.list ?? []).filter((a) => a.id);
    const declaredById = new Map(declaredAgents.map((a) => [a.id!, a]));

    const existingAgents = db.prepare('SELECT id, name, agent_provider, archived_at FROM agent_groups').all() as Array<{
      id: string;
      name: string;
      agent_provider: string | null;
      archived_at: string | null;
    }>;
    const existingById = new Map(existingAgents.map((r) => [r.id, r]));

    const insertAgent = db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const updateAgent = db.prepare(`UPDATE agent_groups SET name = ?, agent_provider = ? WHERE id = ?`);
    const unarchiveAgent = db.prepare(`UPDATE agent_groups SET archived_at = NULL WHERE id = ?`);

    for (const agent of declaredAgents) {
      const id = agent.id!;
      const name = agent.name || id;
      const provider = agent.provider ?? null;
      const existing = existingById.get(id);
      if (!existing) {
        insertAgent.run(id, name, id, provider, now);
        summary.agentGroups.inserted.push(id);
      } else {
        if (existing.name !== name || existing.agent_provider !== provider) {
          updateAgent.run(name, provider, id);
          summary.agentGroups.updated.push(id);
        }
        if (existing.archived_at !== null) {
          unarchiveAgent.run(id);
        }
      }
    }
    for (const r of existingAgents) {
      if (!declaredById.has(r.id) && r.archived_at === null) {
        db.prepare(`UPDATE agent_groups SET archived_at = datetime('now') WHERE id = ?`).run(r.id);
        summary.agentGroups.archived.push(r.id);
      }
    }

    // ── 2. users from all allowFrom lists + role-bound ids ─────────────
    const users = collectAllowFromUsers(config);
    const roles = collectRoleBindings(config);
    for (const r of roles) {
      if (!users.has(r.userId)) users.set(r.userId, r.channelType);
    }

    const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, kind, created_at) VALUES (?, ?, ?)`);
    for (const [userId, channelType] of users) {
      const info = insertUser.run(userId, channelType, now);
      if (info.changes > 0) summary.users.inserted.push(userId);
    }

    // ── 3. user_roles full sync (owner + admin, both global) ───────────
    // Declared set = (user_id, role) pairs from roleBindings.
    // Existing set = current global user_roles (agent_group_id IS NULL).
    // Insert missing, delete obsolete.
    const declaredRoleSet = new Set<string>(); // key = `${userId}|${role}`
    for (const r of roles) declaredRoleSet.add(`${r.userId}|${r.role}`);

    const existingRoles = db
      .prepare(
        `SELECT user_id, role FROM user_roles
          WHERE agent_group_id IS NULL AND role IN ('owner','admin')`,
      )
      .all() as Array<{ user_id: string; role: string }>;
    const existingRoleSet = new Set<string>(existingRoles.map((r) => `${r.user_id}|${r.role}`));

    const insertRole = db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
       VALUES (?, ?, NULL, ?)`,
    );
    const deleteRole = db.prepare(`DELETE FROM user_roles WHERE user_id = ? AND role = ? AND agent_group_id IS NULL`);

    for (const r of roles) {
      const key = `${r.userId}|${r.role}`;
      if (!existingRoleSet.has(key)) {
        const info = insertRole.run(r.userId, r.role, now);
        if (info.changes > 0) summary.userRoles.inserted.push(r.userId);
      }
    }
    for (const key of existingRoleSet) {
      if (!declaredRoleSet.has(key)) {
        const [uid, role] = key.split('|');
        deleteRole.run(uid, role);
        summary.userRoles.deleted.push(uid);
      }
    }

    // Set of owner ids — these are implicit members and skipped from
    // agent_group_members projection.
    const ownerSet = new Set(roles.filter((r) => r.role === 'owner').map((r) => r.userId));

    // ── 4. agent_group_members: project allowFrom → membership ────────
    const liveAgentGroupIds = db.prepare(`SELECT id FROM agent_groups WHERE archived_at IS NULL`).all() as Array<{
      id: string;
    }>;
    const insertMember = db.prepare(
      `INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
       VALUES (?, ?, NULL, ?)`,
    );
    for (const [userId] of users) {
      if (ownerSet.has(userId)) continue;
      for (const ag of liveAgentGroupIds) {
        const info = insertMember.run(userId, ag.id, now);
        if (info.changes > 0) summary.agentGroupMembers.inserted += 1;
      }
    }

    // ── 4b. bindings[] → messaging_group_agents (peer.id only) ─────────
    // Minimal wiring: only insert when the binding pins a specific peer
    // AND the messaging_groups row already exists. Wildcards / unbound
    // peers are skipped — the router still consults bindings at routing
    // time. We do not auto-create messaging_groups here; first-inbound
    // lazy-create lives in the router commit.
    const bindings = (config as { bindings?: import('../config-loader.js').Binding[] }).bindings ?? [];
    if (bindings.length > 0) {
      const findMgByPeer = db.prepare(
        `SELECT id, is_group FROM messaging_groups
          WHERE channel_type = ? AND platform_id = ?`,
      );
      const insertMga = db.prepare(
        `INSERT OR IGNORE INTO messaging_group_agents
           (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
            sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, ?, ?, 'all', 'drop', 'shared', 0, ?)`,
      );
      const liveAgentSet = new Set(liveAgentGroupIds.map((r) => r.id));
      for (const b of bindings) {
        const peerId = b.match?.peer?.id;
        const channel = b.match?.channel;
        if (!peerId || !channel || !b.agentId) continue;
        if (!liveAgentSet.has(b.agentId)) continue;
        const channelType = channelKeyToType(channel);
        const mg = findMgByPeer.get(channelType, peerId) as { id: string; is_group: number } | undefined;
        if (!mg) continue;
        const isGroup = Number(mg.is_group) === 1;
        const engageMode = isGroup ? 'mention-sticky' : 'pattern';
        const engagePattern: string | null = isGroup ? null : '.';
        const mgaId = `mga:${mg.id}:${b.agentId}`;
        const info = insertMga.run(mgaId, mg.id, b.agentId, engageMode, engagePattern, now);
        if (info.changes > 0) summary.messagingGroupAgents.inserted += 1;
      }
    }

    // ── 5. messaging_group_agents engage_mode projection ───────────────
    const channelsCfg = (config.channels ?? {}) as Record<string, MutableChannel>;
    const updateEngage = db.prepare(
      `UPDATE messaging_group_agents
          SET engage_mode = ?, engage_pattern = ?
        WHERE messaging_group_id = ?`,
    );
    const findMg = db.prepare(
      `SELECT id FROM messaging_groups
        WHERE channel_type = ? AND platform_id = ? AND is_group = 1`,
    );
    for (const [channelKey, channelDef] of Object.entries(channelsCfg)) {
      const channelType = channelKeyToType(channelKey);
      const accounts = channelDef?.accounts;
      if (!accounts) continue;
      for (const acc of Object.values(accounts)) {
        const groups = acc?.groups;
        if (!groups) continue;
        for (const [peerId, gDef] of Object.entries(groups)) {
          const requireMention = gDef?.requireMention !== false;
          const engageMode = requireMention ? 'mention-sticky' : 'pattern';
          const engagePattern: string | null = requireMention ? null : '.';
          const mgRow = findMg.get(channelType, peerId) as { id: string } | undefined;
          if (!mgRow) continue;
          const info = updateEngage.run(engageMode, engagePattern, mgRow.id);
          summary.messagingGroupAgents.updated += Number(info.changes ?? 0);
        }
      }
    }
  });

  tx();
  return summary;
}
