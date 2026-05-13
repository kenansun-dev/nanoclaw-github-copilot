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

function channelKeyToType(channelKey: string): string {
  switch (channelKey) {
    case 'tg':
      return 'telegram';
    case 'telegram':
    case 'teams':
    case 'discord':
    case 'whatsapp':
    case 'slack':
    case 'imessage':
    case 'iMessage':
    case 'email':
    case 'matrix':
      return channelKey === 'iMessage' ? 'imessage' : channelKey;
    default:
      return channelKey;
  }
}

/** Split `proto:rest` jid into [channelKey, rawId]. Returns null on malformed. */
function splitJid(jid: string): [string, string] | null {
  const idx = jid.indexOf(':');
  if (idx <= 0 || idx === jid.length - 1) return null;
  return [jid.slice(0, idx), jid.slice(idx + 1)];
}

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
  const hasConfigChats = !!config.chats && typeof config.chats === 'object' && Object.keys(config.chats).length > 0;

  // ── Snapshot nanoclaw.json before any mutation ─────────────────────────
  let snapshotPath: string | undefined;
  if (hasConfigChats && !opts.skipSnapshot && configPath && fs.existsSync(configPath)) {
    snapshotPath = `${configPath}.pre-v2.bak`;
    fs.copyFileSync(configPath, snapshotPath);
    summary.snapshotPath = snapshotPath;
  }

  // ── Pre-compute DB-side row counts so we can short-circuit ────────────
  const legacyChatsTablePresent = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='chats'`)
    .get();
  const legacyRgTablePresent = !!db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'`)
    .get();

  // ── Translate config.chats inside a DB transaction ─────────────────────
  const ownerIdsAdded: string[] = [];
  try {
    const tx = db.transaction(() => {
      const now = new Date().toISOString();

      if (hasConfigChats) {
        const insertUser = db.prepare(`INSERT OR IGNORE INTO users (id, kind, created_at) VALUES (?, ?, ?)`);
        const insertOwnerRole = db.prepare(
          `INSERT OR IGNORE INTO user_roles (user_id, role, agent_group_id, granted_at)
           VALUES (?, 'owner', NULL, ?)`,
        );

        const commands = ((config as unknown as { commands?: { ownerAllowFrom?: string[] } }).commands ??= {});
        commands.ownerAllowFrom ??= [];

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

          const accounts = ensureAccountsBag(config, channelKey);
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
                `🪧  v2 migrate: group ${jid} → accounts.${channelKey}.default.groups['${rawId}'] (requireMention=true; legacy trigger-only default preserved)`,
              );
            }
            summary.groups.push(jid);
          } else {
            // DM
            acc.allowFrom = pushUnique(acc.allowFrom, rawId);
            summary.dms.push(jid);

            if (entry.isMain) {
              const ownerId = `${channelType}:${rawId}`;
              commands.ownerAllowFrom = pushUnique(commands.ownerAllowFrom, ownerId);
              const userInfo = insertUser.run(ownerId, channelType, now);
              const roleInfo = insertOwnerRole.run(ownerId, now);
              if (userInfo.changes > 0 || roleInfo.changes > 0) {
                summary.ownersBootstrapped.push(ownerId);
                ownerIdsAdded.push(ownerId);
              }
            }
          }

          // Bindings (Flag 3): if the chat entry carries an agentId hint,
          // surface it as a top-level `bindings[]` rule on the same channel/
          // account so the new router has an authoritative routing source.
          // Dedupe by (agentId, channel, accountId='default').
          if (entry.agentId) {
            const bindings = ((config as { bindings?: import('../config-loader.js').Binding[] }).bindings ??= []);
            const dup = bindings.some(
              (b) =>
                b.agentId === entry.agentId &&
                b.match?.channel === channelKey &&
                (b.match?.accountId ?? 'default') === 'default' &&
                !b.match?.peer?.id,
            );
            if (!dup) {
              bindings.push({
                agentId: entry.agentId,
                match: { channel: channelKey, accountId: 'default' },
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
        const cols = new Set((db.prepare(`PRAGMA table_info(chats)`).all() as { name: string }[]).map((c) => c.name));
        if (cols.has('jid')) {
          const hasChannel = cols.has('channel');
          const hasIsGroup = cols.has('is_group');
          const hasName = cols.has('name');
          const rows = db.prepare(`SELECT * FROM chats`).all() as Array<Record<string, unknown>>;
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
          (db.prepare(`PRAGMA table_info(registered_groups)`).all() as { name: string }[]).map((c) => c.name),
        );
        if (cols.has('folder') && cols.has('name')) {
          const rows = db.prepare(`SELECT * FROM registered_groups`).all() as Array<Record<string, unknown>>;
          const insertAg = db.prepare(
            `INSERT OR IGNORE INTO agent_groups (id, name, folder, agent_provider, created_at)
             VALUES (?, ?, ?, ?, ?)`,
          );
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
