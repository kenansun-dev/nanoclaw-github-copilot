/**
 * Registered groups (fork add-on) — module wire-up.
 *
 * Re-exports the fork's `getRegisteredGroup` family from `src/db.ts`
 * AND wires a v2 router `GroupResolverFn` so dispatcher code can
 * resolve a per-chat `RegisteredGroup` row (folder / trigger /
 * containerConfig / isMain) without importing `db.ts` directly.
 *
 * The resolver looks up by `MessagingGroup.platform_id` (fork's
 * `RegisteredGroup` table keys on platform-native chat jid).
 *
 * Per kenan 23:20 policy "全收 v2 features": this stays as a fork
 * add-on rather than replacing the v2 routing context — v2 routing
 * doesn't need the row, but dispatcher/container code does.
 */
import {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setRegisteredGroup,
  removeRegisteredGroup,
} from '../../db.js';
import {
  setGroupResolver,
  type GroupResolverFn,
} from '../../router.js';
import { log } from '../../log.js';
import type { MessagingGroup, RegisteredGroup } from '../../types.js';

export const registeredGroupsFork = {
  getAllRegisteredGroups,
  getRegisteredGroup,
  setRegisteredGroup,
  removeRegisteredGroup,
};

/**
 * Build a router GroupResolverFn that consults the fork's
 * `registered_groups` table, keyed by `mg.platform_id`.
 */
export function makeRegisteredGroupsResolver(): GroupResolverFn {
  return (mg: MessagingGroup, _event): RegisteredGroup | null => {
    try {
      const row = getRegisteredGroup(mg.platform_id);
      if (!row) return null;
      // Drop the synthetic { jid } extra that getRegisteredGroup tacks on.
      // Caller wants the canonical RegisteredGroup shape from types.ts.
      const { jid: _jid, ...rest } = row;
      return rest;
    } catch (err) {
      log.warn('registered-groups resolver: lookup failed', {
        err,
        platformId: mg.platform_id,
      });
      return null;
    }
  };
}

let installed = false;

/**
 * Install the registered-groups resolver on the v2 router. Idempotent.
 */
export function installRegisteredGroupsFork(): void {
  if (installed) return;
  installed = true;
  setGroupResolver(makeRegisteredGroupsResolver());
}

/** Test-only: re-allow installRegisteredGroupsFork to run again. */
export function __resetRegisteredGroupsForkInstalledForTests(): void {
  installed = false;
}
