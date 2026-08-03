/**
 * Logger runtime-control tests.
 *
 * Covers the new mutable threshold + setLogLevel/applyConfigLogLevel surface
 * added to support `nanoclaw loglevel` (live log level changes via SIGUSR2).
 *
 * NOTE: logger.ts reads process.env.LOG_LEVEL at module load, so these tests
 * have to be careful about import order. We import the module fresh after
 * unsetting the env var to get a clean baseline.
 */

import { describe, it, expect, beforeAll } from 'vitest';

// Strip env LOG_LEVEL before importing so the module's lock-in starts fresh.
delete process.env.LOG_LEVEL;
const { getLogLevel, setLogLevel, applyConfigLogLevel, getValidLevels } = await import('./log-extensions.js');

describe('logger runtime control', () => {
  beforeAll(() => {
    // Make sure we start from a known baseline. The module init already ran;
    // since LOG_LEVEL was unset, level should be 'info' and not env-locked.
    setLogLevel('info', { force: true });
  });

  it('exposes the canonical level set', () => {
    expect(getValidLevels()).toEqual(['debug', 'info', 'warn', 'error', 'fatal']);
  });

  it('starts at info when env LOG_LEVEL is unset', () => {
    expect(getLogLevel()).toBe('info');
  });

  it('setLogLevel changes the active level', () => {
    setLogLevel('debug');
    expect(getLogLevel()).toBe('debug');
    setLogLevel('warn');
    expect(getLogLevel()).toBe('warn');
  });

  it('setLogLevel rejects invalid levels', () => {
    expect(() => setLogLevel('verbose')).toThrowError(/Invalid log level/);
    expect(() => setLogLevel('')).toThrowError(/Invalid log level/);
  });

  it('setLogLevel is case-insensitive and trims input', () => {
    setLogLevel('  DEBUG  ');
    expect(getLogLevel()).toBe('debug');
  });

  it('applyConfigLogLevel updates level when no env lock', () => {
    setLogLevel('info', { force: true });
    applyConfigLogLevel('warn');
    expect(getLogLevel()).toBe('warn');
  });

  it('applyConfigLogLevel ignores unknown values silently', () => {
    setLogLevel('info', { force: true });
    applyConfigLogLevel('bogus');
    expect(getLogLevel()).toBe('info');
  });

  it('applyConfigLogLevel ignores undefined/empty', () => {
    setLogLevel('debug', { force: true });
    applyConfigLogLevel(undefined);
    expect(getLogLevel()).toBe('debug');
    applyConfigLogLevel('');
    expect(getLogLevel()).toBe('debug');
  });
});

/**
 * B3 regression (2026-08-03): the pre-fix bug was that setLogLevel only
 * updated the *name* returned by getLogLevel(), while emit()'s gate in
 * log.ts kept comparing against a frozen module-const `threshold`. So
 * `ncl loglevel debug` reported success but produced zero extra output.
 * These tests assert the actual emit gate moves, not just the label.
 */
describe('B3: setLogLevel moves the real emit gate (not just the label)', () => {
  async function captureStdout(fn: () => void): Promise<string> {
    const chunks: string[] = [];
    const orig = process.stdout.write.bind(process.stdout);
    (process.stdout as any).write = (s: any) => {
      chunks.push(typeof s === 'string' ? s : String(s));
      return true;
    };
    try {
      fn();
    } finally {
      (process.stdout as any).write = orig;
    }
    return chunks.join('');
  }

  it('emits debug lines after setLogLevel(debug), and suppresses them after setLogLevel(warn)', async () => {
    const { log } = await import('./log.js');

    setLogLevel('warn', { force: true });
    const suppressed = await captureStdout(() => log.debug('DEBUG_SHOULD_BE_HIDDEN'));
    expect(suppressed).not.toContain('DEBUG_SHOULD_BE_HIDDEN');

    setLogLevel('debug', { force: true });
    const shown = await captureStdout(() => log.debug('DEBUG_SHOULD_SHOW'));
    expect(shown).toContain('DEBUG_SHOULD_SHOW');

    // Flip back down: the gate must tighten again (this is the exact
    // no-op the fix addresses — previously the gate never changed).
    setLogLevel('warn', { force: true });
    const suppressedAgain = await captureStdout(() => log.debug('DEBUG_HIDDEN_AGAIN'));
    expect(suppressedAgain).not.toContain('DEBUG_HIDDEN_AGAIN');

    setLogLevel('info', { force: true });
  });

  it('applyConfigLogLevel also moves the emit gate', async () => {
    const { log } = await import('./log.js');
    setLogLevel('info', { force: true });
    applyConfigLogLevel('debug');
    const shown = await captureStdout(() => log.debug('CFG_DEBUG_SHOWS'));
    expect(shown).toContain('CFG_DEBUG_SHOWS');
    setLogLevel('info', { force: true });
  });
});
