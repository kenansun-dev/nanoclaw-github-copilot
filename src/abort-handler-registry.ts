/**
 * Abort-handler registry — B.5-prep #4 skeleton.
 *
 * Hook surface for fast-abort short-circuits before the dispatcher
 * spends LLM/CLI cycles. A handler is `{ matcher, onAbort }`; per
 * inbound message the dispatcher walks registered handlers, runs the
 * first one whose `matcher` returns `true`, and stops.
 *
 * Modules (e.g. `abort-extensions`) self-register at import time. Registry
 * lives at `src/` root, dependency-free, mirroring the conventions of
 * `response-registry.ts` / `delivery.ts` / `channel-registry.ts` /
 * `access-gate-registry.ts`.
 *
 * Status: SKELETON — registry surface only, no production caller yet.
 * Wire-up to `src/index.ts` lines 1841-1857 lands in Phase B.5
 * dispatcher work.
 */

/**
 * `NewMessage`-equivalent shape passed to `onAbort`. Kept structural
 * (instead of importing `src/types.ts`) so this file stays
 * dependency-free per registry-pattern conventions. The B.5
 * dispatcher will pass the real `NewMessage` from `src/types.ts`,
 * which is shape-compatible.
 */
export interface AbortMessage {
  sender: string;
  content: string;
  // Other NewMessage fields are intentionally unconstrained here;
  // handlers cast to the full type if they need more context.
  [k: string]: unknown;
}

export interface AbortHandler {
  matcher: (text: string) => boolean;
  onAbort: (chatJid: string, msg: AbortMessage) => Promise<void>;
}

const abortHandlers: AbortHandler[] = [];

/**
 * Register an abort handler. Modules call this at import time.
 * Order of registration determines `checkAbort` evaluation order;
 * first matching handler wins.
 */
export function registerAbortHandler(h: AbortHandler): void {
  abortHandlers.push(h);
}

/**
 * Find the first registered handler whose `matcher` returns `true`
 * for `content`, or `null` if none match.
 *
 * Caller pattern (per B.5-prep #2 design):
 *   const h = checkAbort(msg.content);
 *   if (h) { await h.onAbort(chatJid, msg); return; }
 */
export function checkAbort(content: string): AbortHandler | null {
  for (const h of abortHandlers) {
    if (h.matcher(content)) return h;
  }
  return null;
}

/**
 * Read-only snapshot of registered handlers. For diagnostics / tests.
 * Production callers should use `checkAbort` instead of iterating
 * directly.
 */
export function getAbortHandlers(): readonly AbortHandler[] {
  return abortHandlers;
}

/**
 * Test-only: clear all registered handlers. Use in `beforeEach` to
 * keep cases independent.
 */
export function __resetAbortHandlersForTests(): void {
  abortHandlers.length = 0;
}
