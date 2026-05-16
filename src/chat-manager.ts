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
/**
 * Compute the v2 folder for a chat.
 *
 * - `shareDefaultAgentSession=true` → mint a folder via `uniqueIsMainFolder`
 *   so DM consumers (TUI, default-agent DMs) collapse to a shared session
 *   at read time (see `collapseMainDmFolder`). 'Main chat' wording retired
 *   2026-05-16.
 * - Otherwise: deterministic per-jid folder (groups stay isolated).
 */
export function deriveGroupFolder(
  jid: string,
  chatConfig?: { shareDefaultAgentSession?: boolean; agentId?: string },
): string {
  if (chatConfig?.shareDefaultAgentSession) {
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
 *
 * `shareDefaultAgentSession=true` opts the chat into the default-agent
 * DM session collapse (TUI + default-agent DMs). v1 'main chat' wording
 * is retired — default agent identity itself comes from
 * `agents.list[].default` in nanoclaw.json, not from any chat row.
 */
export function addChat(
  jid: string,
  name: string,
  options: {
    shareDefaultAgentSession?: boolean;
    requiresTrigger?: boolean;
    agentId?: string;
  } = {},
): { jid: string } {
  const config = loadConfig();
  const folder = deriveGroupFolder(jid, {
    shareDefaultAgentSession: options.shareDefaultAgentSession,
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
 * setMainChat / 'main chat' concept retired 2026-05-16.
 *
 * v2 has no global 'main chat' pointer. Default agent identity is
 * configured via `agents.list[].default` in nanoclaw.json. Per-chat
 * session collapse for DMs is opt-in at registration time via
 * `addChat(jid, name, { shareDefaultAgentSession: true })`.
 */
export function setMainChat(_jid: string | null): void {
  logger.info('setMainChat is a no-op (v2 has no main chat concept)');
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
