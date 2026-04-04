/**
 * Chat manager for nanoclaw.
 * Handles chat registration (pairing), pending chats, and chat CRUD.
 * Reads/writes chats section of nanoclaw.json + syncs with SQLite DB.
 */

import { loadConfig, saveConfig, NanoclawConfig } from './config-loader.js';
import { setRegisteredGroup, getAllRegisteredGroups } from './db.js';
import { logger } from './logger.js';

export interface ChatInfo {
  jid: string;
  name: string;
  isMain: boolean;
  channel?: string;
  lastMessageTime?: string;
}

/**
 * Derive a unique group folder name from a chat JID and its config.
 * When an agentId is assigned, the folder includes the agent prefix to
 * prevent session collisions when multiple agents share the same chat
 * (e.g. two Teams bots in one group conversation).
 */
export function deriveGroupFolder(
  jid: string,
  chatConfig?: { isMain?: boolean; agentId?: string },
): string {
  if (chatConfig?.isMain) return 'main';

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
 */
export function syncChatsFromConfig(config: NanoclawConfig): void {
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
      logger.info({ jid, name: chatConfig.name, folder }, 'Chat synced from config');
    }
  }
}

/**
 * Add a chat to nanoclaw.json and register it in the DB.
 */
export function addChat(
  jid: string,
  name: string,
  options: { isMain?: boolean; requiresTrigger?: boolean; agentId?: string } = {},
): void {
  const config = loadConfig();

  config.chats[jid] = {
    name,
    isMain: options.isMain,
    requiresTrigger: options.requiresTrigger,
  };

  saveConfig(config);

  const folder = deriveGroupFolder(jid, { isMain: options.isMain, agentId: options.agentId });
  setRegisteredGroup(jid, {
    name,
    folder,
    trigger: config.agents.defaults.triggerWord,
    added_at: new Date().toISOString(),
    requiresTrigger: options.requiresTrigger ?? false,
    isMain: options.isMain ?? false,
  });

  logger.info({ jid, name, folder }, 'Chat added');
}

/**
 * Remove a chat from nanoclaw.json.
 * Note: doesn't remove from DB (preserves history).
 */
export function removeChat(jid: string): boolean {
  const config = loadConfig();
  if (!config.chats[jid]) return false;

  delete config.chats[jid];
  saveConfig(config);

  logger.info({ jid }, 'Chat removed from config');
  return true;
}

/**
 * List all registered chats.
 */
export function listChats(): ChatInfo[] {
  const groups = getAllRegisteredGroups();
  return Object.entries(groups).map(([jid, g]) => ({
    jid,
    name: g.name,
    isMain: g.isMain ?? false,
    channel: jid.startsWith('tg:')
      ? 'telegram'
      : jid.startsWith('teams:')
        ? 'teams'
        : 'unknown',
  }));
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
