import { describe, it, expect, afterEach } from 'vitest';

import { getDb, initTestDb, closeDb, isDbInitialized } from './connection.js';

describe('central DB handle (globalThis-pinned)', () => {
  afterEach(() => {
    closeDb();
  });

  it('isDbInitialized reflects init/close lifecycle', () => {
    closeDb();
    expect(isDbInitialized()).toBe(false);
    initTestDb();
    expect(isDbInitialized()).toBe(true);
    closeDb();
    expect(isDbInitialized()).toBe(false);
  });

  it('getDb throws before init, returns handle after', () => {
    closeDb();
    expect(() => getDb()).toThrow(/Database not initialized/);
    const db = initTestDb();
    expect(getDb()).toBe(db);
  });

  it('handle is stored under the global Symbol.for key (shared across module copies)', () => {
    initTestDb();
    const key = Symbol.for('nanoclaw.db.central');
    // A duplicate module instance (Windows drive-casing / dynamic import drift)
    // resolves the SAME registered symbol, so it reads the same handle.
    expect((globalThis as Record<symbol, unknown>)[key]).toBe(getDb());
  });
});
