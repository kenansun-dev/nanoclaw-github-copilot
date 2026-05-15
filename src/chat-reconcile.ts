/**
 * Chat registry reconcile.
 *
 * Two stores have evolved independently in this codebase:
 *   - `config.chats` (nanoclaw.json) — persistent, has the user-facing `id`.
 *   - `registered_groups` table (DB) — runtime state, written directly by
 *     `pair`, `tui-direct`, inbound handlers, and `addChat`.
 *
 * Production deploy of PR #14 (kenansun, 2026-04-20) showed they drift:
 * `chat list` showed 8 chats with no ids, because those entries lived
 * only in `registered_groups` and never made it into `config.chats`.
 *
 * `reconcileChatRegistry()` is the eager fix: for every chat in
 * `registered_groups` not in `config.chats`, add a `config.chats[jid]`
 * entry (with a fresh `id` from `nextChatId`) and copy across `name`.
 *
 * Idempotent: a second call on the reconciled state is a no-op.
 *
 * Pure-side: caller must `initDatabase()` before invoking.
 *
 * v1 `isMain` cutover (PR #49, Path A): the dedupe + mirror logic that
 * synchronized `chats[].isMain` ↔ `registered_groups.is_main` was removed.
 * Default-agent designation now flows from `agents.list[].default` in v2.
 */

import { loadConfig, saveConfig, nextChatId, type NanoclawConfig } from './config-loader.js';
import { getAllRegisteredGroups, getAllChatIsGroup } from './db.js';
import { logger } from './log-extensions.js';

export interface ReconcileResult {
  added: string[]; // jids newly inserted into config.chats
  dedupedMains: string[]; // retained for back-compat — always empty post-PR#49
  mirroredToDb: string[]; // retained for back-compat — always empty post-PR#49
  keptMain: string | null; // retained for back-compat — always null post-PR#49
}

/**
 * Reconcile `config.chats` with `registered_groups`.
 *
 * Returns a summary of what changed. Persists via `saveConfig` if
 * anything actually moved.
 */
export function reconcileChatRegistry(): ReconcileResult {
  const config = loadConfig();
  const groups = getAllRegisteredGroups();

  const result: ReconcileResult = {
    added: [],
    dedupedMains: [],
    mirroredToDb: [],
    keptMain: null,
  };

  // Backfill DB-only chats into config.chats.
  for (const [jid, g] of Object.entries(groups)) {
    if (config.chats[jid]) continue;
    const id = nextChatId(config);
    config.chats[jid] = {
      id,
      name: g.name,
      ...(g.requiresTrigger ? { requiresTrigger: true } : {}),
    };
    result.added.push(jid);
  }

  if (result.added.length > 0) {
    saveConfig(config);
    logger.info({ added: result.added.length }, 'Chat registry reconciled');
  }

  return result;
}

/**
 * Dry-run reconcile: compute what `reconcileChatRegistry()` would change,
 * without writing anything.
 */
export function detectChatDrift(): ReconcileResult & { dirty: boolean } {
  const config = loadConfig();
  const groups = getAllRegisteredGroups();
  const isGroupByJid = getAllChatIsGroup();
  const clone: NanoclawConfig = {
    ...config,
    chats: JSON.parse(JSON.stringify(config.chats)),
  };
  const r = _reconcilePure(clone, groups, isGroupByJid);
  const dirty = r.added.length > 0;
  return {
    added: r.added,
    dedupedMains: r.dedupedMains,
    mirroredToDb: r.mirroredToDb,
    keptMain: r.keptMain,
    dirty,
  };
}

/**
 * Test-only: reconcile a passed-in config object (no I/O), returning the
 * same result shape. Used by config-loader.test.ts to exercise the merge
 * logic without touching the real DB.
 */
export function _reconcilePure(
  config: NanoclawConfig,
  groups: Record<
    string,
    {
      name: string;
      requiresTrigger?: boolean;
      folder?: string;
      trigger?: string;
      added_at?: string;
    }
  >,
  _isGroupByJid?: Map<string, boolean | undefined>,
): ReconcileResult & { config: NanoclawConfig } {
  const result: ReconcileResult = {
    added: [],
    dedupedMains: [],
    mirroredToDb: [],
    keptMain: null,
  };

  for (const [jid, g] of Object.entries(groups)) {
    if (config.chats[jid]) continue;
    const id = nextChatId(config);
    config.chats[jid] = {
      id,
      name: g.name,
      ...(g.requiresTrigger ? { requiresTrigger: true } : {}),
    };
    result.added.push(jid);
  }

  return { ...result, config };
}
