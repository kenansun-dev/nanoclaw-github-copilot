/**
 * Session recovery helpers — extracted from agent-runner main() so they can
 * be unit-tested independently. Pure functions only; no SDK imports.
 *
 * Bug context: 2026-04-23 GHC session-not-found incident. See
 * src/ghc-session-recovery.test.ts for the regression guard on the loop
 * structure, and tests in this file for the recovery-decision logic.
 */

/**
 * Returns true if a thrown error from `session.send()` (or `resumeSession()`)
 * indicates the SDK has lost track of the session and we should recover by
 * re-resuming or re-creating.
 *
 * Matches the SDK's exact error shape: `Session not found: <uuid>` (raised
 * from app.js SESSION_SEND/SESSION_RESUME handlers when activeSessions Map
 * does not contain the requested sessionId).
 */
export function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /session\s*not\s*found/i.test(msg);
}

