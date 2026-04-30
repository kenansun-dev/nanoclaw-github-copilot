/**
 * Task scheduler — fork → v2 bridge.
 *
 * v2 (`upstream/feat/migrate-from-v1`) deleted `src/task-scheduler.ts`
 * entirely; scheduling moved into per-session inbound.db `messages_in`
 * rows driven by `src/modules/scheduling/{actions,db}.ts`. The fork
 * preserves the v1 polling loop because today's fork-only features
 * (auto-pause on missing groups, `context_mode='isolated'`,
 * `MAX_CONSECUTIVE_GROUP_MISSING`, group-folder snapshot writes) are
 * not yet ported to v2's session-scoped scheduling.
 *
 * This bridge exists so:
 *
 *   1. `src/index.ts` imports `startSchedulerLoop` from a stable path
 *      that the dispatcher cut (B.5.3) can flip to v2 mode without
 *      another import-site rewrite.
 *   2. v2-mode (when `src/index.ts` activates the v2 startup) gets a
 *      hook point to divert the per-task firing from "spawn container
 *      directly via fork's runContainerAgent" to "write a session
 *      messages_in row + wakeContainer(session)" without rewriting
 *      `src/task-scheduler.ts` itself.
 *   3. The fork v1 loop remains the live path during the merge — no
 *      behavior change today.
 *
 * B.5 dispatcher-cut work (in B.5.3):
 *   - `src/index.ts` changes `import { startSchedulerLoop } from './task-scheduler.js'`
 *     to `from './task-scheduler-bridge.js'` (this file re-exports it).
 *   - When v2 startup mode is active, `src/index.ts` will call
 *     `setSchedulerV2DispatchHook(v2Fn)` before `startSchedulerLoop(...)`.
 *   - When the hook is set, fork's task-scheduler `runTask` short-
 *     circuits to the hook instead of calling `runContainerAgent`. Wiring
 *     of that short-circuit lands in B.5.3 alongside the dispatcher cut.
 *
 * Why a bridge file instead of editing `src/task-scheduler.ts`:
 *   - Keeps `src/task-scheduler.ts` as a near-verbatim fork v1 file,
 *     easier to re-sync if v2-merge needs to abort.
 *   - Centralises the v2-mode toggle, with the rest of v2 toggles in
 *     module-level startup glue (sender-allowlist-extensions, abort-extensions,
 *     etc.).
 */

import {
  startSchedulerLoop as forkStartSchedulerLoop,
  type SchedulerDependencies,
  computeNextRun,
  MAX_CONSECUTIVE_GROUP_MISSING,
  _resetSchedulerLoopForTests,
} from './task-scheduler.js';
import type { ScheduledTask } from './types.js';

/**
 * v2-mode dispatch hook. When set (by B.5.3 dispatcher cut after v2
 * startup activates), fork's task-scheduler `runTask` defers to this
 * function instead of spawning a container directly.
 *
 * Today: hook is `null`, fork v1 path runs unchanged.
 */
export type SchedulerV2DispatchFn = (
  task: ScheduledTask,
  deps: SchedulerDependencies,
) => Promise<void>;

let v2DispatchHook: SchedulerV2DispatchFn | null = null;

export function setSchedulerV2DispatchHook(
  fn: SchedulerV2DispatchFn | null,
): void {
  v2DispatchHook = fn;
}

export function getSchedulerV2DispatchHook(): SchedulerV2DispatchFn | null {
  return v2DispatchHook;
}

/**
 * Bridge re-export of fork's poll loop. Today this is identity — the
 * fork v1 loop runs as-is. B.5.3 will gate the inner per-task dispatch
 * path on `getSchedulerV2DispatchHook()` once v2 startup is the live
 * code path.
 */
export function startSchedulerLoop(deps: SchedulerDependencies): void {
  forkStartSchedulerLoop(deps);
}

// Re-export companion symbols so `./task-scheduler-bridge.js`
// is a drop-in for `./task-scheduler.js` everywhere. Index.ts only
// needs `startSchedulerLoop` today; tests + future callers may want
// the others.
export {
  computeNextRun,
  MAX_CONSECUTIVE_GROUP_MISSING,
  _resetSchedulerLoopForTests,
};
export type { SchedulerDependencies };
