/**
 * Chat manager for nanoclaw.
 * Handles chat registration (pairing), pending chats, and chat CRUD.
 * Reads/writes chats section of nanoclaw.json + syncs with SQLite DB.
 */

import {
  loadConfig,
  saveConfig,
  NanoclawConfig,
  nextChatId,
} from './config-loader.js';
import {
  setRegisteredGroup,
  getAllRegisteredGroups,
  removeRegisteredGroup,
} from './db.js';
import { reconcileChatRegistry } from './chat-reconcile.js';
import { logger } from './logger.js';
import { uniqueIsMainFolder } from './session-routing.js';

export interface ChatInfo {
  id?: number;
  jid: string;
  name: string;
  isMain: boolean;
  channel?: string;
  lastMessageTime?: string;
}

/**
 * Derive a unique group folder name from a chat JID and its config.
 *
 * For isMain chats we generate a unique-per-jid folder so multiple chats
 * marked isMain can coexist in the DB (the `registered_groups.folder UNIQUE`
 * constraint forbids two rows with the same folder). They are *collapsed* back
 * to a canonical 'main' (or 'main-<agent>') at read time by
 * `collapseMainDmFolder` in session-routing.ts — only when authoritative
 * `chats.is_group` says the chat is a DM. Group chats marked isMain keep
 * their unique folder and stay isolated.
 *
 * For non-isMain chats with an assigned agentId, the folder includes the
 * agent prefix to prevent session collisions when multiple agents share the
 * same chat (e.g. two Teams bots in one group conversation).
 */
export function deriveGroupFolder(
  jid: string,
  chatConfig?: { isMain?: boolean; agentId?: string },
): string {
  if (chatConfig?.isMain) {
    // Unique per jid in the DB; collapse-on-read maps DM mains back to
    // a shared canonical folder. Existing rows with folder='main' continue
    // to work — collapse is a no-op for them.
    return uniqueIsMainFolder(jid, chatConfig.agentId);
  }

  const base = jid.replace(/[^a-zA-Z0-9-]/g, '-');

  // Include agentId in folder name when assigned to ensure isolation
  if (chatConfig?.agentId) {
    const agentSlug = chatConfig.agentId.replace(/[^a-zA-Z0-9-]/g, '-');
    const combined = `${agentSlug}--${base}`;
    // Group folder max length is 64 chars; truncate base if needed
    if (combined.length > 64) {
      const maxBase = 64 - agentSlug.length - 2; // 2 for '--'
      return `${agentSlug}--${base.slice(0, Math.max(8, maxBase))}`;
    }
    return combined;
  }

  // Truncate to 64 chars for non-agent folders too
  return base.slice(0, 64);
}

/**
 * Sync chats from nanoclaw.json into the SQLite DB.
 * Called on startup to ensure DB matches config.
 *
 * Also runs `reconcileChatRegistry` first so DB-only chats (created by
 * inbound handlers, `pair`, or `tui-direct` without a corresponding
 * `addChat` call) are imported into config.chats with proper ids and the
 * "at most one isMain" invariant is enforced across both stores.
 * Without this, a fresh PR #14 deploy would see `config.chats = {}` and
 * `chat list` would print every id as `?` (kenansun, 2026-04-20 deploy).
 */
export function syncChatsFromConfig(config: NanoclawConfig): void {
  // Reconcile is best-effort: if it fails (e.g. partial DB during init)
  // we still fall through to the legacy config→DB sync below.
  try {
    reconcileChatRegistry();
    // Reload config for the loop below now that reconcile may have added entries.
    config = loadConfig();
  } catch (err: any) {
    logger.warn(
      { err: err?.message },
      'Chat reconcile skipped — falling back to one-way config→DB sync',
    );
  }

  const existing = getAllRegisteredGroups();

  for (const [jid, chatConfig] of Object.entries(config.chats)) {
    if (!existing[jid]) {
      const folder = deriveGroupFolder(jid, chatConfig);
      setRegisteredGroup(jid, {
        name: chatConfig.name,
        folder,
        trigger: config.agents.defaults.triggerWord,
        added_at: new Date().toISOString(),
        requiresTrigger: chatConfig.requiresTrigger ?? false,
        isMain: chatConfig.isMain ?? false,
      });
      logger.info(
        { jid, name: chatConfig.name, folder },
        'Chat synced from config',
      );
    }
  }
}

/**
 * Add a chat to nanoclaw.json and register it in the DB.
 */
export function addChat(
  jid: string,
  name: string,
  options: {
    isMain?: boolean;
    requiresTrigger?: boolean;
    agentId?: string;
  } = {},
): { id: number } {
  const config = loadConfig();

  // Reuse existing id if this jid is already in config; else assign next free.
  const existingId = config.chats[jid]?.id;
  const id = typeof existingId === 'number' ? existingId : nextChatId(config);

  config.chats[jid] = {
    id,
    name,
    isMain: options.isMain,
    requiresTrigger: options.requiresTrigger,
  };

  saveConfig(config);

  const folder = deriveGroupFolder(jid, {
    isMain: options.isMain,
    agentId: options.agentId,
  });
  setRegisteredGroup(jid, {
    name,
    folder,
    trigger: config.agents.defaults.triggerWord,
    added_at: new Date().toISOString(),
    requiresTrigger: options.requiresTrigger ?? false,
    isMain: options.isMain ?? false,
  });

  logger.info({ id, jid, name, folder }, 'Chat added');
  return { id };
}

/**
 * Set or clear the main chat. Pass null to clear.
 * `target` is a jid (already validated by caller).
 */
export function setMainChat(jid: string | null): void {
  const config = loadConfig();
  for (const [j, entry] of Object.entries(config.chats)) {
    const shouldBeMain = jid !== null && j === jid;
    if (shouldBeMain && !entry.isMain) entry.isMain = true;
    else if (!shouldBeMain && entry.isMain) delete entry.isMain;
  }
  saveConfig(config);
  logger.info({ jid }, jid ? 'Main chat set' : 'Main chat cleared');
}

/**
 * Remove a chat from nanoclaw.json AND from the DB registered_groups
 * table. Without the DB delete the next `chat *` CLI call would re-run
 * reconcile and re-add the same jid with a new id, defeating the remove.
 */
export function removeChat(jid: string): boolean {
  const config = loadConfig();
  const inConfig = !!config.chats[jid];
  if (inConfig) {
    delete config.chats[jid];
    saveConfig(config);
  }
  const removedFromDb = removeRegisteredGroup(jid);

  if (!inConfig && !removedFromDb) return false;
  logger.info(
    { jid, fromConfig: inConfig, fromDb: removedFromDb },
    'Chat removed',
  );
  return true;
}

/**
 * List all registered chats.
 */
export function listChats(): ChatInfo[] {
  const groups = getAllRegisteredGroups();
  const config = loadConfig();
  return Object.entries(groups)
    .map(([jid, g]) => ({
      id: config.chats[jid]?.id,
      jid,
      name: g.name,
      isMain: g.isMain ?? false,
      channel: jid.startsWith('tg:')
        ? 'telegram'
        : jid.startsWith('teams:')
          ? 'teams'
          : jid.startsWith('dc:')
            ? 'discord'
            : jid.startsWith('wa:')
              ? 'whatsapp'
              : 'unknown',
    }))
    .sort((a, b) => (a.id ?? 1e9) - (b.id ?? 1e9));
}

/**
 * List pending (unregistered) chats that have sent messages.
 * These are in the chats table but not in registered_groups.
 */
export function listPendingChats(): ChatInfo[] {
  // This requires direct DB access — import db module
  // For now, return empty. Will be implemented when we wire up the DB query.
  return [];
}
