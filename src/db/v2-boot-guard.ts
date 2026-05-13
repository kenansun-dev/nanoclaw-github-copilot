/**
 * v2 boot guard — defuses the legacy `sessions` table before migration 001
 * runs `CREATE TABLE sessions (...)` without `IF NOT EXISTS`.
 *
 * The legacy fork's `createSchema()` (src/db.ts) produced a `sessions` table
 * keyed on `(group_folder, provider)`. Upstream migration 001 creates a
 * different `sessions` table keyed on `id` UUID with an `agent_group_id` FK,
 * and the statement is **not** `CREATE TABLE IF NOT EXISTS`. On any prod DB
 * that was previously built by `createSchema()` (i.e. `~/.nanoclaw/store/messages.db`),
 * running 001 would crash with `table sessions already exists`.
 *
 * Strategy: detect the legacy schema (sessions table present, `group_folder`
 * column present, and no `schema_version` row yet), snapshot the DB file,
 * and rename `sessions` → `sessions_legacy_v1` so 001 can proceed cleanly.
 *
 * The guard is idempotent: re-runs after the rename are no-ops.
 */
import fs from 'node:fs';

import type Database from 'better-sqlite3';

import { log } from '../log.js';

interface ColumnInfo {
  name: string;
}

interface TableInfo {
  name: string;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
    .get(name) as TableInfo | undefined;
  return !!row;
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as ColumnInfo[];
  return new Set(rows.map((r) => r.name));
}

/**
 * Snapshot + rename the legacy `sessions` table if present and not yet migrated.
 *
 * @param db     open better-sqlite3 handle
 * @param dbPath on-disk path of the DB (or `:memory:`); used for the snapshot.
 *               Pass an empty string or `:memory:` to skip the file copy.
 * @returns      true if the guard fired (rename performed), false on no-op
 */
export function prepareForV2Migrations(db: Database.Database, dbPath: string): boolean {
  // Idempotency short-circuit: if the rename already happened, nothing to do.
  if (tableExists(db, 'sessions_legacy_v1')) return false;

  if (!tableExists(db, 'sessions')) return false;

  const cols = columnNames(db, 'sessions');
  const isLegacy = cols.has('group_folder') && cols.has('provider');
  if (!isLegacy) return false;

  // If `schema_version` already exists and has any rows, the migration
  // system has already been initialised on this DB — bail out to avoid
  // touching a half-migrated DB. (This shouldn't happen because 001
  // would have crashed first, but defend in depth.)
  if (tableExists(db, 'schema_version')) {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM schema_version`).get() as { c: number };
    if (row.c > 0) return false;
  }

  // Snapshot the DB file before mutation. Skip for in-memory DBs and the
  // empty-string sentinel that callers use to opt out of the backup.
  const skipBackup = !dbPath || dbPath === ':memory:';
  let backupPath = '';
  if (!skipBackup) {
    backupPath = `${dbPath}.pre-v2.bak`;
    try {
      fs.copyFileSync(dbPath, backupPath);
    } catch (err) {
      log.warn('v2 boot guard: snapshot failed; aborting rename', {
        dbPath,
        backupPath,
        error: (err as Error).message,
      });
      return false;
    }
  }

  db.exec(`ALTER TABLE sessions RENAME TO sessions_legacy_v1`);

  const banner = skipBackup
    ? `🛡️  v2 boot guard: legacy sessions table renamed → sessions_legacy_v1 (in-memory db, no backup)`
    : `🛡️  v2 boot guard: legacy sessions table renamed → sessions_legacy_v1; backup at ${backupPath}`;
  log.info(banner);

  return true;
}
