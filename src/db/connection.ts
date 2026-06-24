import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

import { log } from '../log.js';

// The central DB handle is stored on `globalThis` under a Symbol key rather
// than a plain module-level `let`. Reason (root cause of kenan's Windows
// 'Host sweep error: Database not initialized' spam every 60s, 2026-06-24):
// ESM module identity is keyed by the resolved module URL. On Windows the
// same file reached via a different drive-letter casing (`c:\` vs `C:\`) or\n// via a dynamic `await import()` whose specifier resolves differently than\n// the static import chain is loaded as a SEPARATE module instance, each with
// its own module-scoped `_db`. `initDb()` ran in the static-graph instance
// (via index.ts boot) and set its `_db`, but host-sweep is pulled in through
// `await import('./host-sweep.js')` and got a second instance whose `_db`
// stayed null forever — so every sweep tick threw. Pinning the handle to
// `globalThis` makes all duplicate instances share one connection, which is
// also the correct invariant: there is exactly one central DB per process.
const DB_HANDLE_KEY = Symbol.for('nanoclaw.db.central');
type DbGlobal = typeof globalThis & { [DB_HANDLE_KEY]?: Database.Database | null };
const dbGlobal = globalThis as DbGlobal;

function getHandle(): Database.Database | null {
  return dbGlobal[DB_HANDLE_KEY] ?? null;
}
function setHandle(db: Database.Database | null): void {
  dbGlobal[DB_HANDLE_KEY] = db;
}

export function getDb(): Database.Database {
  const db = getHandle();
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

/** Whether the central DB handle has been initialized in this process. */
export function isDbInitialized(): boolean {
  return getHandle() !== null;
}

export function initDb(dbPath: string): Database.Database {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  setHandle(db);
  log.info('Central DB initialized', { path: dbPath });
  return db;
}

/** For tests only — creates an in-memory DB and runs migrations. */
export function initTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  setHandle(db);
  return db;
}

export function closeDb(): void {
  getHandle()?.close();
  setHandle(null);
}

/**
 * Check whether a table exists. Used by core code that touches
 * module-owned tables so that an uninstalled module degrades silently
 * instead of raising SQLite errors. Cheap: a single indexed lookup on
 * sqlite_master. Results are not cached — a module install adds the
 * table at runtime (next service start), and callers may run before
 * or after that boundary.
 */
export function hasTable(db: Database.Database, name: string): boolean {
  const row = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1`).get(name) as
    | { '1': number }
    | undefined;
  return row !== undefined;
}
