/**
 * v2 config-shape reconcile pipeline (PR-B, step 3).
 *
 * `reconcileConfigToDb(config, db)` is the bridge from declared config
 * (nanoclaw.json) to runtime DB state (v2 tables). Idempotent and
 * transactional: failure rolls back, re-run finds the same end state.
 *
 * Scope (per docs/proposals/2026-05-12-config-shape-v2.md §"Reconcile
 * pipeline"):
 *
 *   1. agents.list[]                  → agent_groups
 *   2. accounts.*.allowFrom           → users (INSERT OR IGNORE)
 *      accounts.*.groupAllowFrom      → users
 *      accounts.*.groups.*.allowFrom  → users
 *   3. commands.ownerAllowFrom        → user_roles (role='owner')
 *
 * Explicitly NOT in scope (lazy / grows on demand):
 *
 *   - messaging_groups: populated on first inbound message per chat
 *     (router work — later commit in this branch).
 *
 * agent_groups removal: agents listed only in DB but not in config are
 * **archived** rather than deleted, to protect FK references from
 * `sessions` / `scheduled_tasks`. Archival is recorded in
 * `agent_provider='archived'` until a proper `archived` column lands
 * (TODO once that schema change is needed).
 *
 * Sender id format note: per-account `allowFrom` entries are raw
 * platform ids (e.g. `8731187021`); `commands.ownerAllowFrom` entries
 * are channel-qualified (e.g. `telegram:8731187021`). DB user ids are
 * always the channel-qualified form `<channelType>:<rawId>`.
 */
import type Database from 'better-sqlite3';

import type { NanoclawConfig } from '../config-loader.js';

interface ReconcileSummary {
  agentGroups: { inserted: string[]; archived: string[]; updated: string[] };
  users: { inserted: string[] };
  userRoles: { inserted: string[]; deleted: string[] };
}

function nowIso(): string {
  return new Date().toISOString();
}

function channelKeyToType(channelKey: string): string {
  // Config uses `telegram` / `teams` / `discord`; DB stores `channel_type`
  // with the same spelling. Map kept explicit so legacy `tg` aliases are
  // surfaced rather than silently mis-typed.
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

function collectAllowFromUsers(config: NanoclawConfig): Map<string, string> {
  // Returns `userId → channelType` for every sender referenced by any
  // `allowFrom` list anywhere under `channels.*.accounts.*`. The DB user
  // id uses the channel-qualified `<channelType>:<rawId>` form.
  const users = new Map<string, string>();
  const channels = config.channels as Record<string, unknown> | undefined;
  if (!channels) return users;
  for (const [channelKey, channelDef] of Object.entries(channels)) {
    const channelType = channelKeyToType(channelKey);
    const accounts = (channelDef as { accounts?: Record<string, unknown> } | undefined)?.accounts;
    if (!accounts) continue;
    for (const acc of Object.values(accounts)) {
      const a = acc as {
        allowFrom?: string[];
        groupAllowFrom?: string[];
        groups?: Record<string, { allowFrom?: string[] }>;
      };
      for (const raw of a.allowFrom ?? []) users.set(`${channelType}:${raw}`, channelType);
      for (const raw of a.groupAllowFrom ?? []) users.set(`${channelType}:${raw}`, channelType);
      for (const g of Object.values(a.groups ?? {})) {
        for (const raw of g.allowFrom ?? []) users.set(`${channelType}:${raw}`, channelType);
      }
    }
  }
  return users;
}

function collectOwnerUserIds(config: NanoclawConfig): string[] {
  // `commands.ownerAllowFrom` is the v2 owner list (proposal §"Reconcile
  // pipeline" step 3). Field is optional on legacy configs; treat absence
  // as empty.
  const cmds = (config as unknown as { commands?: { ownerAllowFrom?: string[] } }).commands;
  return Array.isArray(cmds?.ownerAllowFrom) ? cmds!.ownerAllowFrom! : [];
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
  };

  const tx = db.transaction(() => {
    const now = nowIso();

    // ── 1. agent_groups from agents.list[] ─────────────────────────────
    const declaredAgents = (config.agents?.list ?? []).filter((a) => a.id);
    const declaredById = new Map(declaredAgents.map((a) => [a.id!, a]));

    const existingAgents = db.prepare('SELECT id, name, agent_provider FROM agent_groups').all() as Array<{
      id: string;
      name: string;
      agent_provider: string | null;
    }>;
    const existingById = new Map(existingAgents.map((r) => [r.id, r]));

    const insertAgent = db.prepare(
      `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const updateAgent = db.prepare(`UPDATE agent_groups SET name = ?, agent_provider = ? WHERE id = ?`);

    for (const agent of declaredAgents) {
      const id = agent.id!;
      const name = agent.name || id;
      const provider = agent.provider ?? null;
      const existing = existingById.get(id);
      if (!existing) {
        insertAgent.run(id, name, id, provider, now);
        summary.agentGroups.inserted.push(id);
      } else if (existing.name !== name || existing.agent_provider !== provider) {
        updateAgent.run(name, provider, id);
        summary.agentGroups.updated.push(id);
      }
    }
    // Archive (do not delete): agents present in DB but no longer in
    // config. Tag via agent_provider='archived' until a real archived
    // column lands. Skip already-archived rows.
    for (const r of existingAgents) {
      if (!declaredById.has(r.id) && r.agent_provider !== 'archived') {
        db.prepare(`UPDATE agent_groups SET agent_provider = 'archived' WHERE id = ?`).run(r.id);
        summary.agentGroups.archived.push(r.id);
      }
    }

    // ── 2. users from all allowFrom lists ──────────────────────────────
    const users = collectAllowFromUsers(config);
    const ownerIds = collectOwnerUserIds(config);
    // owners must also exist in `users` even if absent from any
    // `allowFrom` (defensive: an owner referenced only by ownerAllowFrom
    // is still a real user).
    for (const ownerId of ownerIds) {
      if (!users.has(ownerId)) {
        const [chan] = ownerId.split(':', 2);
        if (chan) users.set(ownerId, chan);
      }
    }

    const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, kind, created_at) VALUES (?, ?, ?)`);
    for (const [userId, channelType] of users) {
      const info = insertUser.run(userId, channelType, now);
      if (info.changes > 0) summary.users.inserted.push(userId);
    }

    // ── 3. user_roles sync: role='owner', agent_group_id=NULL ──────────
    // Per proposal: owner is global (agent_group_id IS NULL). Sync the
    // set of owners exactly: insert new ones, delete rows no longer in
    // ownerAllowFrom.
    const existingOwners = db
      .prepare(`SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL`)
      .all() as Array<{ user_id: string }>;
    const existingOwnerSet = new Set(existingOwners.map((r) => r.user_id));
    const declaredOwnerSet = new Set(ownerIds);

    const insertOwnerRole = db.prepare(
      `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
       VALUES (?, 'owner', NULL, ?)`,
    );
    const deleteOwnerRole = db.prepare(
      `DELETE FROM user_roles WHERE user_id = ? AND role = 'owner' AND agent_group_id IS NULL`,
    );

    for (const ownerId of declaredOwnerSet) {
      if (!existingOwnerSet.has(ownerId)) {
        const info = insertOwnerRole.run(ownerId, now);
        if (info.changes > 0) summary.userRoles.inserted.push(ownerId);
      }
    }
    for (const existing of existingOwnerSet) {
      if (!declaredOwnerSet.has(existing)) {
        deleteOwnerRole.run(existing);
        summary.userRoles.deleted.push(existing);
      }
    }
  });

  tx();
  return summary;
}
