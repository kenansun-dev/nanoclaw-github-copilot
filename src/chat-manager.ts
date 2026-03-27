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
 * Sync chats from nanoclaw.json into the SQLite DB.
 * Called on startup to ensure DB matches config.
 */
export function syncChatsFromConfig(config: NanoclawConfig): void {
  const existing = getAllRegisteredGroups();

  for (const [jid, chatConfig] of Object.entries(config.chats)) {
    if (!existing[jid]) {
      const folder = chatConfig.isMain
        ? 'main'
        : jid.replace(/[^a-zA-Z0-9-]/g, '-');
      setRegisteredGroup(jid, {
        name: chatConfig.name,
        folder,
        trigger: config.assistant.triggerWord,
        added_at: new Date().toISOString(),
        requiresTrigger: chatConfig.requiresTrigger ?? false,
        isMain: chatConfig.isMain ?? false,
      });
      logger.info({ jid, name: chatConfig.name }, 'Chat synced from config');
    }
  }
}

/**
 * Add a chat to nanoclaw.json and register it in the DB.
 */
export function addChat(
  jid: string,
  name: string,
  options: { isMain?: boolean; requiresTrigger?: boolean } = {},
): void {
  const config = loadConfig();

  config.chats[jid] = {
    name,
    isMain: options.isMain,
    requiresTrigger: options.requiresTrigger,
  };

  saveConfig(config);

  const folder = options.isMain ? 'main' : jid.replace(/[^a-zA-Z0-9-]/g, '-');
  setRegisteredGroup(jid, {
    name,
    folder,
    trigger: config.assistant.triggerWord,
    added_at: new Date().toISOString(),
    requiresTrigger: options.requiresTrigger ?? false,
    isMain: options.isMain ?? false,
  });

  logger.info({ jid, name }, 'Chat added');
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
