/**
 * Access-gate registry — B.5-prep #4 skeleton.
 *
 * Hook surface for per-message access gating. Modules (e.g.
 * `sender-allowlist-fork`) self-register a gate at import time;
 * the dispatcher calls `runAccessGates(...)` per message and the
 * first non-`'allow'` decision wins.
 *
 * Lives at `src/` root (not `modules/`) for the same reason as
 * `response-registry.ts` / `delivery.ts` / `channel-registry.ts`:
 * dispatcher consults it, modules self-register against it, and we
 * must avoid a TDZ hazard if a module imports the registry at the
 * top of `src/index.ts`'s side-effect chain.
 *
 * Keep this file dependency-free. No imports from `src/index.ts`,
 * `src/modules/*`, or anything that could pull in the dispatcher.
 *
 * Status: SKELETON — registry surface only, no production caller yet.
 * Wire-up to `src/index.ts` lines 399 / 1271 / 1888-1891 lands in
 * Phase B.5 dispatcher work.
 */

export type AccessGateDecision = 'allow' | 'drop' | 'deny';

export type AccessGate = (
  chatJid: string,
  sender: string,
  content: string,
) => AccessGateDecision;

const accessGates: AccessGate[] = [];

/**
 * Register an access gate. Modules call this at import time.
 * Order of registration determines evaluation order in
 * `runAccessGates`; first non-`'allow'` decision wins.
 */
export function registerAccessGate(gate: AccessGate): void {
  accessGates.push(gate);
}

/**
 * Run all registered access gates against a message. Returns the
 * first non-`'allow'` decision, or `'allow'` if every gate passed
 * (including the empty-registry case, which is permissive by design
 * — gating is opt-in via registration).
 */
export function runAccessGates(
  chatJid: string,
  sender: string,
  content: string,
): AccessGateDecision {
  for (const gate of accessGates) {
    const decision = gate(chatJid, sender, content);
    if (decision !== 'allow') return decision;
  }
  return 'allow';
}

/**
 * Read-only snapshot of registered gates. For diagnostics / tests.
 * Production callers should use `runAccessGates` instead of iterating
 * directly.
 */
export function getAccessGates(): readonly AccessGate[] {
  return accessGates;
}

/**
 * Test-only: clear all registered gates. NOT exported through any
 * production index/barrel; tests import this directly via the file
 * path. Use in `beforeEach` to keep cases independent.
 */
export function __resetAccessGatesForTests(): void {
  accessGates.length = 0;
}
