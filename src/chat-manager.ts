/**
 * Chat manager for nanoclaw (v2-only, post 2026-05-16 cutover).
 *
 * Source of truth: `messaging_groups` (MG) ⋈ `messaging_group_agents` (MGA)
 * ⋈ `agent_groups`. There is no longer a `config.chats` section in
 * nanoclaw.json — chat presence is implied by inbound traffic + pair flow,
 * and managed via `nanoclaw chat add/remove/list`.
 *
 * The v1 facade in `db.ts` (`setRegisteredGroup` / `getAllRegisteredGroups`
 * / `removeRegisteredGroup`) still delegates to v2 MG+MGA; this module
 * uses it as a stable abstraction so consumers (CLI, status-text) keep
 * a single API.
 */

import { setRegisteredGroup, getAllRegisteredGroups, removeRegisteredGroup } from './db.js';
import { logger } from './log-extensions.js';
import { uniqueIsMainFolder, isDefaultAgentDmFolder } from './session-routing.js';
import { loadConfig } from './config-loader.js';

export interface ChatInfo {
  jid: string;
  name: string;
  isDefaultAgent: boolean;
  channel?: string;
}

/**
 * Derive a unique group folder name from a chat JID and its config.
 *
 * Default-agent chats get a unique-per-jid folder so multiple chats sharing
 * that designation can coexist (folder UNIQUE constraint). They are
 * collapsed back to a canonical 'main' (or 'main-<agent>') at read time
 * by `collapseMainDmFolder` in session-routing.ts — only when authoritative
 * `chats.is_group` says the chat is a DM. Group chats marked default-agent
 * keep their unique folder and stay isolated.
 *
 * For other chats with an assigned agentId, the folder includes the
 * agent prefix to prevent session collisions when multiple agents share
 * the same chat.
 */
export function deriveGroupFolder(jid: string, chatConfig?: { isDefaultAgent?: boolean; agentId?: string }): string {
  if (chatConfig?.isDefaultAgent) {
    return uniqueIsMainFolder(jid, chatConfig.agentId);
  }

  const base = jid.replace(/[^a-zA-Z0-9-]/g, '-');

  if (chatConfig?.agentId) {
    const agentSlug = chatConfig.agentId.replace(/[^a-zA-Z0-9-]/g, '-');
    const combined = `${agentSlug}--${base}`;
    if (combined.length > 64) {
      const maxBase = 64 - agentSlug.length - 2;
      return `${agentSlug}--${base.slice(0, Math.max(8, maxBase))}`;
    }
    return combined;
  }

  return base.slice(0, 64);
}

/**
 * Add a chat to the v2 MG+MGA tables (via the v1 facade).
 *
 * Post-2026-05-16: no longer touches `nanoclaw.json`. Chats live solely
 * in DB. Returns the assigned MG id (`mg-…` string) for caller convenience.
 */
export function addChat(
  jid: string,
  name: string,
  options: {
    isDefaultAgent?: boolean;
    requiresTrigger?: boolean;
    agentId?: string;
  } = {},
): { jid: string } {
  const config = loadConfig();
  const folder = deriveGroupFolder(jid, {
    isDefaultAgent: options.isDefaultAgent,
    agentId: options.agentId,
  });
  setRegisteredGroup(jid, {
    name,
    folder,
    trigger: config.agents.defaults.triggerWord,
    added_at: new Date().toISOString(),
    requiresTrigger: options.requiresTrigger ?? false,
  });

  logger.info({ jid, name, folder }, 'Chat added');
  return { jid };
}

/**
 * Set or clear the default agent designation for a chat.
 *
 * Post-2026-05-16 (v1 cutover): default-agent designation lives in v2
 * via the chat's folder (`uniqueIsMainFolder`). To "set main" we re-add
 * the chat with `isDefaultAgent: true` (which regenerates the folder);
 * to clear we re-add with `isDefaultAgent: false`. Other v2 fields
 * (engage_mode, sender allowlist) are preserved by the v1 facade's
 * upsert path.
 *
 * `target=null` is a no-op (no global "main pointer" exists in v2 — every
 * chat is independent; the share-session collapse on read picks one).
 */
export function setMainChat(jid: string | null): void {
  if (jid === null) {
    logger.info('Main chat clear requested — no-op in v2 (no global pointer)');
    return;
  }
  const groups = getAllRegisteredGroups();
  const group = groups[jid];
  if (!group) {
    logger.warn({ jid }, 'setMainChat: jid not registered');
    return;
  }
  const config = loadConfig();
  const folder = deriveGroupFolder(jid, { isDefaultAgent: true });
  setRegisteredGroup(jid, {
    name: group.name,
    folder,
    trigger: group.trigger ?? config.agents.defaults.triggerWord,
    added_at: group.added_at ?? new Date().toISOString(),
    requiresTrigger: group.requiresTrigger ?? false,
  });
  logger.info({ jid, folder }, 'Default-agent chat set');
}

/**
 * Remove a chat from the v2 tables.
 */
export function removeChat(jid: string): boolean {
  const removed = removeRegisteredGroup(jid);
  if (removed) logger.info({ jid }, 'Chat removed');
  return removed;
}

/**
 * List all registered chats.
 */
export function listChats(): ChatInfo[] {
  const groups = getAllRegisteredGroups();
  return Object.entries(groups)
    .map(([jid, g]) => ({
      jid,
      name: g.name,
      isDefaultAgent: isDefaultAgentDmFolder(g.folder),
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
    .sort((a, b) => a.jid.localeCompare(b.jid));
}

/**
 * List pending (unregistered) chats that have sent messages.
 * Stub kept for API compatibility — not yet wired to v2.
 */
export function listPendingChats(): ChatInfo[] {
  return [];
}
