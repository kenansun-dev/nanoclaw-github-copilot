/**
 * Helpers for `src/cli/tui-direct.ts` sandbox-path close-sentinel logic.
 *
 * Extracted so the decision rule can be unit-tested + mutation-verified
 * without spinning a real container. Pairs with the bug fix for
 * "P1 — tui --ask sandbox path leaks containers and hangs"
 * (docs/2026-05-01-feat-review-followups.md).
 *
 * Co-authored: VM lane authored the helper module + 12 mutation-verified
 * tests; rpi5 lane authored the original inline fix in tui-direct.ts +
 * the idleTimeout default change. This file is VM's contribution adopted
 * via cross-agent collation (see commit message).
 */

/**
 * Decide whether a `ContainerOutput` is a FINAL output that should
 * trigger a `_close` sentinel write. The agent-runner-ghc loop emits
 * `partial:true` chunks and `status:'thinking'` markers in between
 * actual results — those must NOT close the container.
 *
 * Rule (mirrors the host-mode runQuery filter at tui-direct.ts:486-491):
 *   - `out.partial === true` → not final
 *   - `status === 'thinking'` AND `result` is falsy → not final (it's
 *     just a "still working" pulse)
 *   - everything else → final IF status is success/error OR result is
 *     populated (covers custom statuses with payload)
 */
export function isFinalOutput(out: {
  status?: string;
  result?: unknown;
  partial?: boolean;
}): boolean {
  if (out.partial) return false;
  if (out.status === 'thinking' && !out.result) return false;
  return out.status === 'success' || out.status === 'error' || !!out.result;
}

/**
 * Pure idempotent gate: returns `true` exactly once for the first final
 * output in a sequence, `false` for everything else (partials, thinking
 * pulses, and any subsequent finals after the first close-trigger).
 *
 * Caller threads `state` across `onOutput` invocations; we don't use a
 * module-level closure so each query has independent close-once
 * semantics.
 */
export interface CloseSentinelState {
  closeWritten: boolean;
}

export function makeCloseSentinelState(): CloseSentinelState {
  return { closeWritten: false };
}

export function shouldWriteCloseSentinel(
  state: CloseSentinelState,
  out: { status?: string; result?: unknown; partial?: boolean },
): boolean {
  if (state.closeWritten) return false;
  if (!isFinalOutput(out)) return false;
  state.closeWritten = true;
  return true;
}
