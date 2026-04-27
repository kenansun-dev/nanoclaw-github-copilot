import { describe, it, expect } from 'vitest';
import fs from 'node:fs';

/**
 * Regression test for the Teams webhook listen() race fixed 2026-04-27.
 *
 * Background: `nanoclaw restart` (systemctl --user restart) kills and
 * respawns the process back-to-back. On respawn the Teams webhook port
 * (default 3978) is often still held in TIME_WAIT, so http.Server.listen()
 * emits an EADDRINUSE 'error' event. The previous implementation only
 * attached a 'listening' callback (passed to listen() as second arg), with
 * no 'error' handler — so the connect() Promise never resolved nor rejected
 * and the Teams channel was silently dead until the next manual stop+start.
 *
 * The fix wraps listen() in a retry loop that:
 *   - registers BOTH 'error' and 'listening' once-handlers per attempt
 *   - retries on EADDRINUSE up to `maxAttempts` times with a 500ms backoff
 *   - rejects the connect() promise on terminal failure (so callers see it)
 *
 * This test pins the source pattern so a future refactor of teams.ts can't
 * silently drop the retry. We deliberately don't instantiate TeamsChannel
 * (its constructor needs a Bot Framework adapter) — same approach as the
 * existing teams-capability.test.ts.
 */
describe('Teams webhook listen() retry', () => {
  const src = fs.readFileSync(new URL('./teams.ts', import.meta.url), 'utf-8');

  it('attaches an error handler before listen()', () => {
    // `.once('error'` (or .on('error') registered before listen) is the
    // contract — without it, EADDRINUSE leaks as an uncaught error and the
    // connect() promise hangs.
    expect(src).toMatch(/once\(['"]error['"]/);
  });

  it('retries on EADDRINUSE', () => {
    expect(src).toMatch(/EADDRINUSE/);
  });

  it('caps retries with a maxAttempts variable', () => {
    expect(src).toMatch(/maxAttempts/);
  });

  it('rejects the connect() promise on terminal failure', () => {
    // The connect() Promise must accept (resolve, reject) — without reject
    // the caller has no way to know listen failed.
    expect(src).toMatch(/new Promise<void>\(\(resolve,\s*reject\)/);
  });

  it('uses listen(port, host) without a callback (callbacks bypass error handler timing)', () => {
    // The bug was `listen(port, host, () => resolve())` — the callback form
    // means the only way to learn about success was via that callback, and
    // there was no parallel error handler. The fix uses the event form.
    // Allow `listen(this.port, '0.0.0.0')` with no third arg.
    expect(src).toMatch(/listen\(this\.port,\s*['"]0\.0\.0\.0['"]\)\s*;/);
  });
});
