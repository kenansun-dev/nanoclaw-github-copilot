/**
 * Chat registry reconcile.
 *
 * Two stores have evolved independently in this codebase:
 *   - `config.chats` (nanoclaw.json) — persistent, has the user-facing `id`
 *     and the `isMain` invariant we ship in PR #14.
 *   - `registered_groups` table (DB) — runtime state, also has its own
 *     `isMain` flag, written directly by `pair`, `tui-direct`, inbound
 *     handlers, and `addChat`.
 *
 * Production deploy of PR #14 (kenansun, 2026-04-20) showed they drift:
 * `chat list` showed 8 chats with no ids and 4 of them flagged `[main]`,
 * because those entries lived only in `registered_groups` and never made
 * it into `config.chats`.
 *
 * `reconcileChatRegistry()` is the eager fix:
 *   1. For every chat in `registered_groups` not in `config.chats`, add a
 *      `config.chats[jid]` entry (with a fresh `id` from `nextChatId`) and
 *      copy across `name` + `isMain`.
 *   2. Re-run the v3→v4 isMain dedupe on the merged set, keeping the
 *      lowest-id main and clearing the rest.
 *   3. Mirror the deduped `isMain` back into `registered_groups` so both
 *      stores agree on a single main.
 *   4. Persist via `saveConfig`.
 *
 * Idempotent: a second call on the reconciled state is a no-op.
 *
 * Pure-side: caller must `initDatabase()` before invoking.
 */

import {
  loadConfig,
  saveConfig,
  nextChatId,
  type NanoclawConfig,
} from './config-loader.js';
import { getAllRegisteredGroups, setRegisteredGroup } from './db.js';
import { logger } from './logger.js';

export interface ReconcileResult {
  added: string[]; // jids newly inserted into config.chats
  dedupedMains: string[]; // jids whose isMain was cleared by dedupe
  mirroredToDb: string[]; // jids whose registered_groups.isMain was changed
  keptMain: string | null; // jid of the surviving main, or null if none
}

/**
 * Reconcile `config.chats` with `registered_groups`.
 *
 * Returns a summary of what changed. Persists via `saveConfig` and
 * `setRegisteredGroup` if anything actually moved.
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

  // 1) Backfill DB-only chats into config.chats.
  for (const [jid, g] of Object.entries(groups)) {
    if (config.chats[jid]) continue;
    const id = nextChatId(config);
    config.chats[jid] = {
      id,
      name: g.name,
      ...(g.isMain ? { isMain: true } : {}),
      ...(g.requiresTrigger ? { requiresTrigger: true } : {}),
    };
    result.added.push(jid);
  }

  // 2) Dedupe isMain on the merged set (lowest id wins).
  const mains = Object.entries(config.chats)
    .filter(([, e]) => e.isMain)
    .sort((a, b) => (a[1].id ?? 1e9) - (b[1].id ?? 1e9));
  if (mains.length > 0) {
    result.keptMain = mains[0][0];
    for (let i = 1; i < mains.length; i++) {
      const [jid, entry] = mains[i];
      delete entry.isMain;
      result.dedupedMains.push(jid);
    }
  }

  // 3) Mirror config.chats.isMain back into registered_groups so both
  //    stores agree. Only touch entries that disagree, and only if the
  //    DB has the row (we never create DB rows here).
  for (const [jid, entry] of Object.entries(config.chats)) {
    const dbEntry = groups[jid];
    if (!dbEntry) continue;
    const wantMain = entry.isMain === true;
    const haveMain = dbEntry.isMain === true;
    if (wantMain !== haveMain) {
      setRegisteredGroup(jid, { ...dbEntry, isMain: wantMain });
      result.mirroredToDb.push(jid);
    }
  }

  // 4) Persist if anything changed.
  if (
    result.added.length > 0 ||
    result.dedupedMains.length > 0 ||
    result.mirroredToDb.length > 0
  ) {
    saveConfig(config);
    logger.info(
      {
        added: result.added.length,
        dedupedMains: result.dedupedMains.length,
        mirroredToDb: result.mirroredToDb.length,
        keptMain: result.keptMain,
      },
      'Chat registry reconciled',
    );
    if (result.dedupedMains.length > 0) {
      logger.warn(
        {
          kept: result.keptMain,
          cleared: result.dedupedMains,
        },
        `Reconcile cleared isMain on ${result.dedupedMains.length} chat(s); ` +
          `kept ${result.keptMain} as main. ` +
          'Run `nanoclaw chat set-main <id>` to choose a different main.',
      );
    }
  }

  return result;
}

/**
 * Test-only: reconcile a passed-in config object (no I/O), returning the
 * same result shape. Used by config-loader.test.ts to exercise the merge
 * + dedupe logic without touching the real DB.
 */
export function _reconcilePure(
  config: NanoclawConfig,
  groups: Record<
    string,
    {
      name: string;
      isMain?: boolean;
      requiresTrigger?: boolean;
      folder?: string;
      trigger?: string;
      added_at?: string;
    }
  >,
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
      ...(g.isMain ? { isMain: true } : {}),
      ...(g.requiresTrigger ? { requiresTrigger: true } : {}),
    };
    result.added.push(jid);
  }

  const mains = Object.entries(config.chats)
    .filter(([, e]) => e.isMain)
    .sort((a, b) => (a[1].id ?? 1e9) - (b[1].id ?? 1e9));
  if (mains.length > 0) {
    result.keptMain = mains[0][0];
    for (let i = 1; i < mains.length; i++) {
      const [jid, entry] = mains[i];
      delete entry.isMain;
      result.dedupedMains.push(jid);
    }
  }

  for (const [jid, entry] of Object.entries(config.chats)) {
    const dbEntry = groups[jid];
    if (!dbEntry) continue;
    const wantMain = entry.isMain === true;
    const haveMain = dbEntry.isMain === true;
    if (wantMain !== haveMain) result.mirroredToDb.push(jid);
  }

  return { ...result, config };
}
