/**
 * v2 helper: "is this group folder the default-agent folder?"
 *
 * The semantic equivalent of v1's `RegisteredGroup.isMain` keyed by
 * folder. In v2, the default agent is declared in `agents.list[]`
 * (entry with `default: true`, else first entry, else `agents.defaults`).
 * `agent_groups.id` equals the folder (see `src/db/v2-migrate-chats.ts:383`
 * — agId = folder), so the default-agent folder is just the chosen
 * agent's id.
 *
 * Authoritative since PR #49 (Path A v1 isMain removal). The previous
 * `isMainDualRead` shim was removed once all host runtime read paths
 * migrated off RegisteredGroup.isMain.
 */

import { getConfig } from './config.js';

/**
 * Returns the v2 answer to "is this folder the privileged
 * (default-agent) folder?", or `null` when v2 has no opinion (config
 * not loaded yet / no agents configured and no `agents.defaults.id`).
 *
 * Pure / side-effect free — reads the cached config snapshot.
 */
export function folderIsDefaultAgent(folder: string): boolean | null {
  if (!folder) return null;
  let cfg: ReturnType<typeof getConfig>;
  try {
    cfg = getConfig();
  } catch {
    // Config not yet loaded (very early boot, tests without bootstrap).
    return null;
  }
  const list = cfg.agents?.list;
  const defaults = cfg.agents?.defaults;
  if (!list || list.length === 0) {
    // Single-agent config → defaults is the only one. `defaults.id` may
    // not be set; fall back to "main" which is the v2-migrate-chats
    // default agent_groups.id (src/db/v2-migrate-chats.ts:383).
    const defId = (defaults as { id?: string } | undefined)?.id ?? 'main';
    return folder === defId;
  }
  const explicit = list.find((a) => a.default === true);
  const chosen = explicit ?? list[0];
  const chosenId = chosen?.id;
  if (!chosenId) return null;
  return folder === chosenId;
}
