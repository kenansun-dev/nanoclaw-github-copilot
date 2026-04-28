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
const { getLogLevel, setLogLevel, applyConfigLogLevel, getValidLevels } =
  await import('./logger.js');

describe('logger runtime control', () => {
  beforeAll(() => {
    // Make sure we start from a known baseline. The module init already ran;
    // since LOG_LEVEL was unset, level should be 'info' and not env-locked.
    setLogLevel('info', { force: true });
  });

  it('exposes the canonical level set', () => {
    expect(getValidLevels()).toEqual([
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
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
