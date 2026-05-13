/**
 * bindings-loader.ts — v2 config bindings → agent-id resolver.
 *
 * See docs/proposals/2026-05-12-config-shape-v2.md §"bindings".
 *
 * A `Binding` (see `config-loader.ts:Binding`) is `{ agentId, match }` where
 * `match` is `{ channel?, accountId?, peer?: { kind?, id? } }`. This loader
 * indexes the array into a 3-layer fallback structure for efficient lookup:
 *
 *   channel
 *     └─ accountId   (or '*' wildcard when binding omits accountId)
 *          └─ peerId (or '*' wildcard when binding omits peer.id)
 *
 * Precedence (highest → lowest), enforced by `resolveBinding`:
 *   1. peerId-specific match within accountId-specific bucket
 *   2. peerId-wildcard ('*') within accountId-specific bucket
 *   3. peerId-specific match within accountId-wildcard ('*') bucket
 *   4. peerId-wildcard ('*') within accountId-wildcard ('*') bucket
 *
 * I.e. a peer-level binding always wins over an accountId-only binding, which
 * always wins over a channel-only wildcard binding (Rpi5 review focus #1).
 *
 * **No-match behavior (Rpi5 review focus #2):** returns `undefined`. The
 * caller decides fallback. Legacy router behavior was
 * `chats[jid].agentId || mainAgentId`; the v2 router (step 6) must
 * replicate this by falling back to `config.agents.list[default].id` (or
 * equivalent) when this function returns `undefined`.
 *
 * **Cache invalidation (Rpi5 review focus #3):** This loader is pure —
 * `loadBindings(config)` builds a fresh table from the passed-in config and
 * does no module-level caching. Callers that cache the table must rebuild
 * after `reloadConfig()` (see `config.ts:reloadConfig`). A convenience
 * `rebuildBindings(config)` helper is exported for that pattern. Grep of
 * `src/` shows the only reload mechanism is `config.ts:reloadConfig()` (called
 * from `ipc.ts`, `index.ts`, `slash-commands.ts`); none of those sites
 * currently emit a "config changed" event the loader could subscribe to, so
 * a per-call/explicit-rebuild model is the right primitive today.
 * TODO: if a config-change event bus is added in a later step, subscribe
 * here and maintain a module-level cached table.
 */

import type { Binding, NanoclawConfig } from './config-loader.js';

const WILDCARD = '*' as const;

/**
 * Indexed bindings table: channel → accountId → peerId → agentId.
 *
 * `accountId` and `peerId` keys use literal `'*'` to represent "no constraint
 * on this dimension" (i.e. the binding's `match` omitted that field). The
 * channel layer always has a concrete channel name — bindings without a
 * `match.channel` are bucketed under the synthetic channel key `'*'` so the
 * resolver can fall back across channels if a future caller passes a
 * cross-channel query.
 */
export interface BindingsTable {
  /** channel → accountId → peerId → agentId */
  byChannel: Record<string, Record<string, Record<string, string>>>;
}

/**
 * Build a `BindingsTable` from a NanoclawConfig. Iterates `config.bindings[]`
 * in array order; if two bindings collide on the same (channel, accountId,
 * peerId) cell, the **first** one wins (matches the legacy
 * `resolveAgentIdFromBindings` "first match wins" behavior). Returns an
 * empty table when `config.bindings` is missing or empty.
 */
export function loadBindings(config: NanoclawConfig): BindingsTable {
  const table: BindingsTable = { byChannel: {} };
  const list: Binding[] | undefined = config.bindings;
  if (!list || list.length === 0) return table;

  for (const b of list) {
    if (!b || typeof b.agentId !== 'string' || !b.agentId) continue;
    const m = b.match ?? {};
    const channel = m.channel || WILDCARD;
    const accountId = m.accountId || WILDCARD;
    const peerId = m.peer?.id || WILDCARD;

    const byAccount = (table.byChannel[channel] ??= {});
    const byPeer = (byAccount[accountId] ??= {});
    // First-write-wins: preserve legacy "first match wins" semantics.
    if (!(peerId in byPeer)) {
      byPeer[peerId] = b.agentId;
    }
  }

  return table;
}

/** Optional input to `resolveBinding`. */
export interface BindingQuery {
  channel: string;
  accountId?: string;
  peerId?: string;
}

/**
 * Resolve a binding query to an agent id.
 *
 * Lookup order (highest precedence first):
 *   1. byChannel[channel][accountId][peerId]
 *   2. byChannel[channel][accountId]['*']
 *   3. byChannel[channel]['*'][peerId]
 *   4. byChannel[channel]['*']['*']
 *   5. (cross-channel fallback) byChannel['*'][accountId][peerId] → … → byChannel['*']['*']['*']
 *
 * Returns `undefined` if nothing matches. **Caller is responsible for
 * legacy fallback to `mainAgentId`** — see file header.
 */
export function resolveBinding(table: BindingsTable, query: BindingQuery): string | undefined {
  const { channel } = query;
  const accountId = query.accountId || WILDCARD;
  const peerId = query.peerId || WILDCARD;

  // Try the requested channel first, then the cross-channel wildcard bucket.
  for (const ch of [channel, WILDCARD]) {
    const byAccount = table.byChannel[ch];
    if (!byAccount) continue;

    // Try concrete accountId → then accountId wildcard.
    for (const acc of accountId === WILDCARD ? [WILDCARD] : [accountId, WILDCARD]) {
      const byPeer = byAccount[acc];
      if (!byPeer) continue;

      // Try concrete peerId → then peer wildcard.
      for (const pid of peerId === WILDCARD ? [WILDCARD] : [peerId, WILDCARD]) {
        const hit = byPeer[pid];
        if (hit) return hit;
      }
    }
  }

  return undefined;
}

/**
 * Convenience helper for callers that want to cache a `BindingsTable`
 * across requests: call this after `reloadConfig()` to refresh.
 *
 * Currently a thin alias for `loadBindings` — the indirection exists so
 * future cache-invalidation wiring (event subscriptions, file watchers)
 * can be added without touching call sites.
 */
export function rebuildBindings(config: NanoclawConfig): BindingsTable {
  return loadBindings(config);
}
