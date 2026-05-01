/**
 * GHC session-not-found recovery — combined regression guard + recovery-helper
 * unit tests.
 *
 * Bug (2026-04-23): Copilot SDK evicts sessions from `activeSessions` between
 * query iterations. Old code took an `if (session) { reuse }` shortcut that
 * skipped re-resume, then `session.send()` threw `Session not found: <id>`,
 * killing the agent-runner subprocess and freezing host-side typing.
 *
 * Two-layer fix:
 *   Layer 1 (between-turn): always re-resume by sessionId on every loop
 *           iteration. Removes the `if (session) reuse` shortcut.
 *   Layer 2 (mid-turn):    catch `Session not found` from session.send →
 *           drop stale session → continue loop → top-of-loop re-resumes
 *           and re-binds listeners fresh.
 *
 * Tests:
 *   - Static guards on index.ts: assert the buggy pattern stays out.
 *   - Recovery-helper unit tests: verify isSessionNotFoundError matches all
 *     SDK error variants and rejects unrelated errors.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

// NOTE: We intentionally do NOT import from container/agent-runner-ghc/src/.
// That subproject has its own tsconfig + ESM 'type: module' + own rootDir,
// and a top-level test importing across project boundaries breaks tsc strict
// mode (TS6059: file not under rootDir). Instead we duplicate the predicates
// here as the test fixture. The actual implementation lives at
// container/agent-runner-ghc/src/session-recovery.ts; the static guards below
// assert the runtime helper is wired into index.ts. If the implementation
// regex ever drifts from this fixture, the static guards fail because the
// import + helper-name string check below stops matching.

const SESSION_NOT_FOUND_RE = /session\s*not\s*found/i;

function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return SESSION_NOT_FOUND_RE.test(msg);
}

const HELPER_SOURCE = path.join(__dirname, '..', 'container', 'agent-runner-ghc', 'src', 'session-recovery.ts');

const AGENT_RUNNER = path.join(__dirname, '..', 'container', 'agent-runner-ghc', 'src', 'index.ts');

describe('GHC session-not-found recovery (regression guard on index.ts)', () => {
  const src = fs.readFileSync(AGENT_RUNNER, 'utf8');
  const helperSrc = fs.readFileSync(HELPER_SOURCE, 'utf8');

  it('does not contain the `if (session) { reuse }` shortcut that caused Session not found', () => {
    // Exact buggy pattern: skipping resumeSession when `session` reference is
    // non-null. Fix branches on `sessionId` instead, which always routes to
    // resume (or create-new on first iteration).
    expect(src).not.toMatch(/if\s*\(\s*session\s*\)\s*\{[^}]*Reusing existing session/);
    expect(src).not.toMatch(/Session already exists from previous iteration/);
  });

  it('always calls resumeSession when sessionId is present (layer 1)', () => {
    expect(src).toMatch(/if\s*\(\s*sessionId\s*\)\s*\{[\s\S]*?client\.resumeSession\(/);
  });

  it('wraps session.send in try/catch with isSessionNotFoundError recovery (layer 2)', () => {
    // Layer 2 must catch the mid-turn case. We assert the two structural
    // invariants: (a) session.send is inside a try, (b) the catch invokes
    // isSessionNotFoundError and continues the loop.
    expect(src).toMatch(/try\s*\{[\s\S]*?await\s+session\.send\(/);
    expect(src).toMatch(/isSessionNotFoundError\(sendErr\)/);
    expect(src).toMatch(/session\s*=\s*null;\s*\/\/ force loop top to re-resume/);
    expect(src).toMatch(/continue;\s*\/\/ re-enter loop with same prompt/);
  });

  it('documents the recovery layers near the loop top', () => {
    expect(src).toMatch(/Layer 1 of GHC session recovery/);
    expect(src).toMatch(/Layer 2 of GHC session-recovery/);
  });

  it('imports isSessionNotFoundError from the helper module (drift guard)', () => {
    // Cross-check: the test fixture (predicates duplicated above) must stay in
    // sync with the actual helper. Here we assert the helper file contains the
    // same regex literals as our fixture. If anyone tightens the helper regex,
    // this test catches the drift.
    expect(src).toMatch(/from '\.\/session-recovery\.js'/);
    expect(src).toMatch(/isSessionNotFoundError\(sendErr\)/);
    expect(helperSrc).toMatch(/\/session\\s\*not\\s\*found\/i/);
  });

  it('layer 2 catch does NOT swallow unrelated errors (rethrow guard)', () => {
    // Negative guard: a future refactor could accidentally make the
    // mid-turn catch block broader (e.g. catching ALL errors and
    // retrying), which would mask network failures, auth failures,
    // and SDK bugs as silent retries. Pin the structural invariant
    // that the unrelated-error path rethrows.
    //
    // Bug class this catches: someone replaces
    //   if (isSessionNotFoundError(sendErr) && sessionId) { recover; continue }
    //   throw sendErr;
    // with a blanket
    //   session = null; continue;
    // (which would leak state corruption into other failure modes).
    expect(src).toMatch(/catch\s*\(\s*sendErr\s*\)\s*\{[\s\S]*?throw\s+sendErr;?\s*\}/);
    // Also assert the recovery branch is gated on BOTH the predicate
    // AND a non-empty sessionId (no point recovering if we never
    // resumed a session — that would loop forever on the create-new
    // path).
    expect(src).toMatch(/if\s*\(\s*isSessionNotFoundError\(sendErr\)\s*&&\s*sessionId\s*\)/);
  });
});

describe('isSessionNotFoundError (recovery decision)', () => {
  it('matches the SDK error shape `Session not found: <uuid>`', () => {
    const err = new Error('Session not found: f57f21be-dec1-40d9-ba94-6c1fab9b8d8a');
    expect(isSessionNotFoundError(err)).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(isSessionNotFoundError(new Error('SESSION NOT FOUND'))).toBe(true);
    expect(isSessionNotFoundError(new Error('session NOT found: abc'))).toBe(true);
  });

  it('tolerates extra whitespace between words', () => {
    expect(isSessionNotFoundError(new Error('Session  not  found: x'))).toBe(true);
  });

  it('matches when the message is wrapped (e.g. JSON-RPC envelope)', () => {
    const err = new Error('Request session.send failed with message: Session not found: abc');
    expect(isSessionNotFoundError(err)).toBe(true);
  });

  it('matches non-Error throwables (string, plain object)', () => {
    expect(isSessionNotFoundError('Session not found: abc')).toBe(true);
    expect(isSessionNotFoundError({ toString: () => 'Session not found: abc' })).toBe(true);
  });

  it('does NOT match unrelated errors', () => {
    expect(isSessionNotFoundError(new Error('Network unreachable'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Forbidden: rate limit'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Job not found: abc'))).toBe(false);
    expect(isSessionNotFoundError(new Error('Repository not found: foo/bar'))).toBe(false);
  });

  it('returns false for null/undefined/empty', () => {
    expect(isSessionNotFoundError(null)).toBe(false);
    expect(isSessionNotFoundError(undefined)).toBe(false);
    expect(isSessionNotFoundError('')).toBe(false);
    expect(isSessionNotFoundError(new Error(''))).toBe(false);
  });
});
