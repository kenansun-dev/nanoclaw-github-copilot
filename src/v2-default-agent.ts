/**
 * v2 helper: "is this group folder the default-agent folder?"
 *
 * The semantic equivalent of v1's `RegisteredGroup.isMain` keyed by
 * folder. In v2, the default agent is declared in
 * `agents.list[]` (entry with `default: true`, else first entry, else
 * `agents.defaults`). `agent_groups.id` equals the folder
 * (see `src/db/v2-migrate-chats.ts:383` — agId = folder), so the
 * default-agent folder is just the chosen agent's id.
 *
 * Used by Bucket C of the isMain cutover (see
 * docs/proposals/2026-05-14-isMain-cutover-buckets.md). Caller picks a
 * dual-read shim:
 *
 *   - Authoritative branch still reads v1 `RegisteredGroup.isMain`
 *     (folder-keyed), behavior unchanged.
 *   - This helper computes the v2 answer in parallel.
 *   - On disagreement, log.warn so we can grep cutover progress.
 *   - Returns `null` (= "v2 cannot decide") when config has no agent
 *     ids; the caller's dual-read should skip the warn in that case
 *     (legacy compat / TUI-only deployments).
 */

import { getConfig } from './config.js';
import { logger } from './log-extensions.js';

/**
 * Returns the v2 answer to "is this folder the privileged
 * (default-agent) folder?", or `null` when v2 has no opinion.
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

/**
 * Dual-read helper: takes the v1 answer + folder, runs the v2 lookup,
 * logs a warn on mismatch, returns the v1 answer (authoritative).
 *
 * Centralized so every IPC site doesn't repeat the warn boilerplate.
 * The mismatch warn is rate-limited per (folder, v1, v2) combination
 * by a process-local Set so one badly-configured chat doesn't spam.
 */
const warnedMismatch = new Set<string>();

export function isMainDualRead(folder: string, v1IsMain: boolean): boolean {
  const v2 = folderIsDefaultAgent(folder);
  if (v2 !== null && v2 !== v1IsMain) {
    const key = `${folder}|${v1IsMain ? 1 : 0}|${v2 ? 1 : 0}`;
    if (!warnedMismatch.has(key)) {
      warnedMismatch.add(key);
      logger.warn(
        { folder, v1IsMain, v2IsDefaultAgent: v2 },
        'isMain dual-read mismatch (Bucket C, see docs/proposals/2026-05-14-isMain-cutover-buckets.md). v1 still authoritative.',
      );
    }
  }
  return v1IsMain;
}

/** Test-only: clear the mismatch dedup set. */
export function __resetIsMainDualReadDedupForTests(): void {
  warnedMismatch.clear();
}
