/**
 * Group-resolver hook for the v2 router.
 *
 * Lives in `registered-groups-extensions` (fork-only) so `src/router.ts`
 * can stay upstream-canonical. Wired by the module's `register()` at
 * boot via `setGroupResolver()`. Read by the dispatcher (L3) via
 * `getResolvedGroup()`.
 *
 * Extracted from `src/router.ts` per Q2 follow-up audit (P2#1):
 * keep upstream-tracked files free of inline fork mutation; put the
 * fork-only hook surface in an `*-extensions` module.
 *
 * Behaviour preserved verbatim from the inline version (single-slot
 * resolver, warn on overwrite, swallow throws and log).
 */

import { log } from '../../log.js';
import type { MessagingGroup, RegisteredGroup } from '../../types.js';
import type { InboundEvent } from '../../channels/adapter.js';

/**
 * Resolver: given a routed `MessagingGroup` + raw `InboundEvent`,
 * return the matching `RegisteredGroup` row, or null when the chat
 * is not registered. The fork DB keys on `platform_id`, but the
 * resolver receives the event too so callers can pick whichever
 * id their store needs.
 */
export type GroupResolverFn = (
  mg: MessagingGroup,
  event: InboundEvent,
) => RegisteredGroup | null;

let groupResolver: GroupResolverFn | null = null;

/**
 * Register the group resolver. Single-slot — overwriting an existing
 * resolver logs a warning (matches `setSenderResolver` semantics).
 */
export function setGroupResolver(fn: GroupResolverFn): void {
  if (groupResolver) {
    log.warn('Group resolver overwritten');
  }
  groupResolver = fn;
}

/**
 * Resolve the `RegisteredGroup` for a routed inbound, or null if no
 * resolver is registered, the chat isn't registered, or the resolver
 * threw. Callers coalesce null to default container/trigger config
 * (the v1 fallback path).
 */
export function getResolvedGroup(
  mg: MessagingGroup,
  event: InboundEvent,
): RegisteredGroup | null {
  if (!groupResolver) return null;
  try {
    return groupResolver(mg, event);
  } catch (err) {
    log.warn('group resolver threw, returning null', { err });
    return null;
  }
}

/** Test-only: clear the registered group resolver. */
export function __resetGroupResolverForTests(): void {
  groupResolver = null;
}
