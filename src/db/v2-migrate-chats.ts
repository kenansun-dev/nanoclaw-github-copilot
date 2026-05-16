/**
 * `migrateChatsToV2(config, db, opts?)` — one-shot translator from the
 * legacy `chats[]` config shape to the v2 split (proposal
 * `docs/proposals/2026-05-12-config-shape-v2.md` §"Migration from chats[]").
 *
 * Two halves run together inside one DB transaction:
 *
 *   Config side (top of proposal):
 *     - snapshot nanoclaw.json → <path>.pre-v2.bak
 *     - for each chats[jid=<proto>:<rawId>]:
 *         · resolve channelKey (`tg` → `telegram`), pick `default` account
 *         · if group: ensureGroupEntry in accounts.<key>.groups (requireMention=true,
 *                    mirroring the legacy trigger-only default; users opt into
 *                    all-message replies post-migration)
 *         · if DM:   pushUnique accounts.<key>.allowFrom
 *                    if entry.isMain → pushUnique commands.ownerAllowFrom
 *                                       + bootstrap users + user_roles(role='owner', agent_group_id=NULL)
 *         · if entry.agentId is set: push `{ agentId, match: { channel, accountId: 'default' } }`
 *                    onto top-level `config.bindings[]` (deduped by tuple)
 *     - delete config.chats
 *     - saveConfig
 *
 *   DB side (Rpi5 audit gap — not in spec):
 *     - legacy `chats` rows  → messaging_groups (INSERT OR IGNORE, account_key='default')
 *     - legacy `registered_groups` rows → agent_groups (INSERT OR IGNORE)
 *
 * Idempotent: re-entry with `!config.chats` and no legacy DB rows is a no-op.
 * All-or-nothing: a thrown error rolls back the DB transaction and restores
 * the snapshot if the config write already happened.
 */
import fs from 'node:fs';

import type Database from 'better-sqlite3';

import type { NanoclawConfig } from '../config-loader.js';
import { saveConfig } from '../config-loader.js';
import { log } from '../log.js';
import { paths } from '../workspace.js';

export interface MigrateChatsOptions {
  /** Override the nanoclaw.json path (defaults to `paths.config`). */
  configPath?: string;
  /** Skip the file snapshot (used in tests with synthetic configs). */
  skipSnapshot?: boolean;
  /** Skip `saveConfig()` (used in tests that don't want to touch disk). */
  skipSaveConfig?: boolean;
  /**
   * Legacy DB handle to read `chats` and `registered_groups` from. The
   * tables only exist on the v1 file (`messages.db`); the v2 file
   * (`v2.db`, passed as the main `db` arg) never carried them. Without
   * this handle the DB-side migration silently no-ops and v1 users lose
   * their chat/group registrations after upgrade. When omitted (fresh
   * install w/o legacy file) the DB-side migration is skipped cleanly.
   */
  legacyDb?: Database.Database;
  /**
   * Authoritative is-group map keyed by jid. When omitted the migrator falls
   * back to a heuristic per protocol (Telegram: rawId starts with `-`,
   * Teams: rawId contains `:`, other channels: assume DM unless name hints
   * otherwise).
   */
  isGroupByJid?: Map<string, boolean>;
}

export interface MigrateChatsSummary {
  dms: string[];
  groups: string[];
  ownersBootstrapped: string[];
  legacyChatsMigrated: number;
  legacyRegisteredGroupsMigrated: number;
  snapshotPath?: string;
  noop: boolean;
}

// channelKeyToType + splitJid live in src/db/channel-key.ts so the
// inverse mapping (typeToChannelKey, used by v2-chat-metadata cutover)
// stays in sync with the forward mapping. Imported above.
import { channelKeyToType, splitJid } from './channel-key.js';

/** Heuristic is-group fallback when no authoritative map is provided. */
function heuristicIsGroup(channelType: string, rawId: string): boolean {
  if (channelType === 'telegram') return rawId.startsWith('-');
  // Teams uses `19:<thread>@thread.v2` for channels/group chats and
  // `29:<aadObjectId>` for personal DMs.
  if (channelType === 'teams') return rawId.startsWith('19:');
  // Default conservative: assume DM. Callers should pass an authoritative
  // `isGroupByJid` whenever possible.
  return false;
}

function pushUnique(list: string[] | undefined, value: string): string[] {
  const arr = list ?? [];
  if (!arr.includes(value)) arr.push(value);
  return arr;
}

interface AccountsBag {
  [accountId: string]: {
    allowFrom?: string[];
    groups?: Record<string, { requireMention?: boolean }>;
    [k: string]: unknown;
  };
}

function ensureAccountsBag(config: NanoclawConfig, channelKey: string): AccountsBag {
  const channels = config.channels as Record<string, { accounts?: AccountsBag; [k: string]: unknown }>;
  const ch = (channels[channelKey] ??= { enabled: false } as never);
  ch.accounts ??= {};
  ch.accounts.default ??= {};
  return ch.accounts;
}

/**
 * Translate legacy `chats[]` + legacy DB tables into v2 shape.
 *
 * Returns a summary describing what changed (empty fields + `noop=true`
 * when nothing was migrated).
 */
export function migrateChatsToV2(
  config: NanoclawConfig,
  db: Database.Database,
  opts: MigrateChatsOptions = {},
): MigrateChatsSummary {
  const summary: MigrateChatsSummary = {
    dms: [],
    groups: [],
    ownersBootstrapped: [],
    legacyChatsMigrated: 0,
    legacyRegisteredGroupsMigrated: 0,
    noop: true,
  };

  const configPath = opts.configPath ?? paths.config;
  // Bug 4 defense: prod configs persist chats under `channels.<k>.chats[]`,
  // not the top-level `chats` Record. loadConfig() normally merges via
  // normalizeChats() but if the migrator is called with a raw config the
  // entries can go missing. Harvest them into `config.chats` first so
  // the loop below is the single source of truth.
  if (
    (!config.chats || Object.keys(config.chats).length === 0) &&
    config.channels &&
    typeof config.channels === 'object'
  ) {
    const harvested: Record<string, { name: string; isMain?: boolean; agentId?: string; requiresTrigger?: boolean }> =
      {};
    for (const [, chDef] of Object.entries(config.channels) as Array<[string, unknown]>) {
      const chats = (chDef as { chats?: unknown })?.chats;
      if (!Array.isArray(chats)) continue;
      for (const entry of chats as Array<{
        jid?: string;
        name?: string;
        isMain?: boolean;
        agentId?: string;
        requiresTrigger?: boolean;
      }>) {
        if (entry?.jid && !harvested[entry.jid]) {
          harvested[entry.jid] = {
            name: entry.name || entry.jid,
            isMain: entry.isMain,
            agentId: entry.agentId,
            requiresTrigger: entry.requiresTrigger,
          };
        }
      }
    }
    if (Object.keys(harvested).length > 0) {
      (config as { chats?: typeof harvested }).chats = harvested;
    }
  }
  const hasConfigChats = !!config.chats && typeof config.chats === 'object' && Object.keys(config.chats).length > 0;

  // ── Snapshot nanoclaw.json before any mutation ─────────────────────────
  let snapshotPath: string | undefined;
  if (hasConfigChats && !opts.skipSnapshot && configPath && fs.existsSync(configPath)) {
    snapshotPath = `${configPath}.pre-v2.bak`;
    fs.copyFileSync(configPath, snapshotPath);
    summary.snapshotPath = snapshotPath;
  }

  // ── Pre-compute DB-side row counts so we can short-circuit ────────────
  // Legacy tables (`chats`, `registered_groups`) live on the v1
  // `messages.db` handle, never on `v2.db`. opts.legacyDb is the v1
  // handle; tests/legacy fixtures may also set them on the main `db`
  // handle so we fall through to it when not provided.
  const legacyDb = opts.legacyDb ?? db;
  const legacyChatsTablePresent = !!legacyDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chats'`)
    .get();
  const legacyRgTablePresent = !!legacyDb
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'`)
    .get();

  // ── Translate config.chats inside a DB transaction ─────────────────────
  const ownerIdsAdded: string[] = [];
  try {
    const tx = db.transaction(() => {
      const now = new Date().toISOString();

      if (hasConfigChats) {
        // Bug 3 fix: legacy configs ship only `agents.defaults`. reconcile
        // step 1 projects `agents.list[]` → agent_groups, so without a list
        // the table stays empty and no messaging_group_agents row can ever
        // bind. Bootstrap a single 'main' entry derived from defaults so
        // the projection has something to work with. Idempotent: skip if
        // the user already declared at least one named agent.
        const agentsCfg = (
          config as unknown as {
            agents?: { defaults?: Record<string, unknown>; list?: Array<Record<string, unknown>> };
          }
        ).agents;
        if (agentsCfg && agentsCfg.defaults && (!Array.isArray(agentsCfg.list) || agentsCfg.list.length === 0)) {
          agentsCfg.list = [{ id: 'main', ...agentsCfg.defaults }];
          log.info('🪧  v2 migrate: bootstrapped agents.list = [{ id: "main", ...defaults }]');
        }
        const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, kind, created_at) VALUES (?, ?, ?)`);
        const insertOwnerRole = db.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
           VALUES (?, 'owner', NULL, ?)`,
        );

        // v2 RBAC cutover: legacy isMain owner promotion now writes to
        // channels.<channelType>.roleBindings (raw id → 'owner').
        // commands.ownerAllowFrom is no longer touched here; if a user
        // config still ships it, reconcileConfigToDb auto-merges + warns.

        for (const [jid, entry] of Object.entries(config.chats!)) {
          const parsed = splitJid(jid);
          if (!parsed) {
            log.warn('migrateChatsToV2: skipping malformed jid', { jid });
            continue;
          }
          const [channelKey, rawId] = parsed;
          const channelType = channelKeyToType(channelKey);

          let isGroup = opts.isGroupByJid?.get(jid);
          if (isGroup === undefined) isGroup = heuristicIsGroup(channelType, rawId);

          const accounts = ensureAccountsBag(config, channelType);
          const acc = accounts.default;

          if (isGroup) {
            acc.groups ??= {};
            // Default mirrors legacy trigger-only behavior: groups only react
            // when the bot is @mentioned / trigger-worded. Users opt into
            // all-message replies by setting `requireMention: false`
            // explicitly on the per-group entry post-migration.
            if (acc.groups[rawId] === undefined) {
              acc.groups[rawId] = { requireMention: true };
              log.info(
                `🪧  v2 migrate: group ${jid} → accounts.${channelType}.default.groups['${rawId}'] (requireMention=true; legacy trigger-only default preserved)`,
              );
            }
            summary.groups.push(jid);
          } else {
            // DM
            acc.allowFrom = pushUnique(acc.allowFrom, rawId);
            summary.dms.push(jid);

            if (entry.isMain) {
              const ownerId = `${channelType}:${rawId}`;
              // v2 RBAC cutover: write to channels.<channelType>.roleBindings
              // (raw id → 'owner') instead of commands.ownerAllowFrom.
              // Shallow-clone `config.channels` and the target channel
              // before mutating: when the loaded config never declared a
              // `channels` key, deepMerge leaves it pointing at the shared
              // DEFAULTS.channels object by reference. Mutation would
              // leak globally and bleed across boots / tests.
              const cfgRoot = config as unknown as {
                channels?: Record<string, { roleBindings?: Record<string, 'owner' | 'admin'>; [k: string]: unknown }>;
              };
              cfgRoot.channels = { ...((cfgRoot.channels ?? {}) as Record<string, never>) };
              const channels = cfgRoot.channels!;
              const existing = channels[channelType] ?? ({ enabled: false } as never);
              const ch = {
                ...existing,
                roleBindings: {
                  ...((existing as { roleBindings?: Record<string, 'owner' | 'admin'> }).roleBindings ?? {}),
                },
              };
              if (ch.roleBindings[rawId] !== 'owner' && ch.roleBindings[rawId] !== 'admin') {
                ch.roleBindings[rawId] = 'owner';
              }
              channels[channelType] = ch as never;
              const userInfo = insertUser.run(ownerId, channelType, now);
              const roleInfo = insertOwnerRole.run(ownerId, now);
              if (userInfo.changes > 0 || roleInfo.changes > 0) {
                summary.ownersBootstrapped.push(ownerId);
                ownerIdsAdded.push(ownerId);
              }
            }
          }

          // Bindings (Flag 3): default to the first declared agent (or the
          // bootstrap-derived 'main') so legacy chats[] (which never carry
          // entry.agentId) still produce a binding the router can match.
          // Without this, bindings[] stays empty → no messaging_group_agents
          // → router drops every message.
          const declaredList = ((config as { agents?: { list?: Array<{ id?: string }> } }).agents?.list ?? [])
            .map((a) => a?.id)
            .filter((id): id is string => !!id);
          const targetAgentId = entry.agentId || declaredList[0] || 'main';
          {
            const bindings = ((config as { bindings?: import('../config-loader.js').Binding[] }).bindings ??= []);
            const dup = bindings.some(
              (b) =>
                b.agentId === targetAgentId &&
                b.match?.channel === channelType &&
                (b.match?.accountId ?? 'default') === 'default' &&
                !b.match?.peer?.id,
            );
            if (!dup) {
              bindings.push({
                agentId: targetAgentId,
                match: { channel: channelType, accountId: 'default' },
              });
            }
          }
        }

        delete (config as { chats?: unknown }).chats;
      }

      // ── DB side: legacy chats → messaging_groups ──────────────────────
      if (legacyChatsTablePresent) {
        // Legacy chats table may be the createSchema() shape OR a tests' bespoke
        // shape. Detect columns first.
        const cols = new Set(
          (legacyDb.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]).map((c) => c.name),
        );
        if (cols.has('jid')) {
          const hasChannel = cols.has('channel');
          const hasIsGroup = cols.has('is_group');
          const hasName = cols.has('name');
          const rows = legacyDb.prepare(`SELECT * FROM chats`).all() as Array<Record<string, unknown>>;
          const insertMg = db.prepare(
            `INSERT OR IGNORE INTO messaging_groups (id, channel_type, account_key, platform_id, is_group, name, created_at)
             VALUES (?, ?, 'default', ?, ?, ?, ?)`,
          );
          for (const r of rows) {
            const jid = r.jid as string;
            if (!jid || jid.startsWith('__')) continue; // skip sentinel rows like __group_sync__
            const parsed = splitJid(jid);
            // Allow a chat row to specify channel column directly; fallback to jid prefix.
            const channelType =
              hasChannel && r.channel ? String(r.channel) : parsed ? channelKeyToType(parsed[0]) : 'unknown';
            const platformId = parsed ? parsed[1] : jid;
            const isGroup = hasIsGroup ? (Number(r.is_group) ? 1 : 0) : 0;
            const name = hasName && r.name ? String(r.name) : null;
            // Use the jid itself as the synthetic PK so re-runs find the row.
            const mgId = `mg:${channelType}:default:${platformId}`;
            const info = insertMg.run(mgId, channelType, platformId, isGroup, name, now);
            if (info.changes > 0) summary.legacyChatsMigrated++;
          }
        }
      }

      // ── DB side: legacy registered_groups → agent_groups ──────────────
      if (legacyRgTablePresent) {
        const cols = new Set(
          (legacyDb.prepare(`PRAGMA table_info(registered_groups)`).all() as { name: string }[]).map((c) => c.name),
        );
        if (cols.has('folder') && cols.has('name')) {
          const rows = legacyDb.prepare(`SELECT * FROM registered_groups`).all() as Array<Record<string, unknown>>;
          const insertAg = db.prepare(
            `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          );
          // Also bridge the chat↔agent pairing into messaging_group_agents.
          // In v1 the (registered_groups.jid, registered_groups.folder) tuple
          // implicitly meant "this chat is paired and routed to this agent
          // group". In v2 that pairing is an MGA row. Without this bridge,
          // post-migrate `/status` reports "not paired" for every legacy
          // chat (caught on first deployment 2026-05-16).
          const findMgByPeer = db.prepare(
            `SELECT id, is_group FROM messaging_groups WHERE channel_type = ? AND platform_id = ?`,
          );
          const insertMga = db.prepare(
            `INSERT OR IGNORE INTO messaging_group_agents
               (id, messaging_group_id, agent_group_id, engage_mode, engage_pattern,
                sender_scope, ignored_message_policy, session_mode, priority, created_at)
             VALUES (?, ?, ?, ?, ?, 'all', 'drop', 'shared', 0, ?)`,
          );
          const hasJid = cols.has('jid');
          const hasRequiresTrigger = cols.has('requires_trigger');
          for (const r of rows) {
            const folder = String(r.folder ?? '');
            const name = String(r.name ?? folder);
            if (!folder) continue;
            // Use `folder` as the agent_groups.id directly so this row aligns
            // with reconcileConfigToDb's id space (which uses raw
            // `config.agents.list[].id`, set equal to folder). Without this
            // unification we'd insert `ag:legacy:<folder>` here and then
            // reconcile's plain INSERT for the same folder would hit the
            // UNIQUE(folder) constraint.
            const agId = folder;
            const info = insertAg.run(agId, name, folder, null, now);
            if (info.changes > 0) summary.legacyRegisteredGroupsMigrated++;

            // Bridge to MGA: needs a messaging_groups row keyed by the same
            // jid (channelType + platformId). Skip if the legacy chat row
            // wasn't migrated (e.g. messages.db.chats missing).
            if (!hasJid || !r.jid) continue;
            const parsed = splitJid(String(r.jid));
            if (!parsed) continue;
            const channelType = channelKeyToType(parsed[0]);
            const platformId = parsed[1];
            const mg = findMgByPeer.get(channelType, platformId) as
              | { id: string; is_group: number }
              | undefined;
            if (!mg) continue;
            const isGroup = Number(mg.is_group) === 1;
            // Mirror v1 trigger semantics: groups stick on @mention; DMs
            // accept any message from allowed senders.
            const requiresTrigger = hasRequiresTrigger ? Number(r.requires_trigger ?? (isGroup ? 1 : 0)) === 1 : isGroup;
            const engageMode = requiresTrigger ? 'mention-sticky' : 'pattern';
            const engagePattern: string | null = requiresTrigger ? null : '.';
            const mgaId = `mga:${mg.id}:${agId}`;
            insertMga.run(mgaId, mg.id, agId, engageMode, engagePattern, now);
          }
        }
      }
    });

    tx();

    summary.noop =
      summary.dms.length === 0 &&
      summary.groups.length === 0 &&
      summary.legacyChatsMigrated === 0 &&
      summary.legacyRegisteredGroupsMigrated === 0;

    // ── Persist config last (after DB tx commits) ─────────────────────────
    // Doing it after the tx means a saveConfig failure leaves the DB ahead
    // of disk; on re-entry, config.chats is gone in memory but on-disk
    // still has it → the next load will retry. We restore the snapshot
    // explicitly on failure below.
    if (hasConfigChats && !opts.skipSaveConfig) {
      try {
        saveConfig(config, 'migration');
      } catch (err) {
        // Best-effort restore: copy snapshot back. The DB rows are
        // INSERT OR IGNORE so re-running the migrator with the restored
        // config converges.
        if (snapshotPath && fs.existsSync(snapshotPath)) {
          try {
            fs.copyFileSync(snapshotPath, configPath);
            log.warn('migrateChatsToV2: saveConfig failed; restored snapshot', { snapshotPath });
          } catch {
            /* leave snapshot in place */
          }
        }
        throw err;
      }
    }
  } catch (err) {
    log.error('migrateChatsToV2 failed', { error: (err as Error).message });
    throw err;
  }

  return summary;
}
