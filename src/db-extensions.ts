/**
 * NanoClaw GHC fork — DB schema extensions.
 *
 * Non-invasive overlay on the upstream `src/db.ts` schema. Tables defined
 * here exist only in the GHC fork; upstream sees a single
 * `initExtensionSchemas(db)` call site after `createSchema(db)` in
 * `src/db.ts`. Adding more extension tables in the future means appending
 * to this file, not touching the core.
 *
 * This file owns:
 *   - `usage_log`        (Phase 1, features/status-cache-stats.md)
 *   - `quota_snapshots`  (Phase 1, features/status-cache-stats.md)
 *
 * Mirrors the `config-extensions.ts` pattern that already segregates
 * GHC-specific config from upstream-compatible loaders.
 */

import type Database from 'better-sqlite3';

import { _getDb } from './db.js';

/**
 * Bootstrap every extension table. Idempotent: safe to call repeatedly.
 * Tracked per-db-handle so each new in-memory test database gets its
 * extension tables on first accessor call without re-running CREATE on
 * already-bootstrapped handles.
 *
 * Callers don't invoke this directly — every accessor in this file
 * calls `getExtDb()` first, which lazily bootstraps the active handle.
 * That keeps `src/db.ts` (upstream-tracked) entirely free of fork
 * coupling: zero call sites, zero imports of this module from there.
 */
const bootstrapped = new WeakSet<Database.Database>();

function getExtDb(): Database.Database {
  const db = _getDb();
  if (!bootstrapped.has(db)) {
    initUsageSchema(db);
    bootstrapped.add(db);
  }
  return db;
}

/**
 * Eager bootstrap entry point — exported for tests / boot scripts that
 * want to materialize the schema before any accessor call (e.g. to
 * inspect `sqlite_master`). Production code never needs to call this.
 */
export function initExtensionSchemas(db: Database.Database): void {
  if (!bootstrapped.has(db)) {
    initUsageSchema(db);
    bootstrapped.add(db);
  }
}

// ─── Usage tracking (Phase 1) ────────────────────────────────────────────────
//
// Per `features/status-cache-stats.md` Phase 1: every successful model call
// from a runner is appended to `usage_log` as one row, plus the most-recent
// quota snapshot per (runner, model) is upserted into `quota_snapshots`.
// `nanoclaw status` will aggregate by SUM/COUNT against `usage_log`; trends
// (`--daily` / `--monthly`) read from the same table; `vacuumUsageLog`
// prunes rows older than N days.
//
// Schema is runner-agnostic: GHC populates everything (cost, ttft, quota),
// CC populates the token columns and leaves cost/ttft NULL. The `runner`
// column ('ghc' | 'cc') discriminates so renderers can hide unsupported
// columns when no row populates them.
//
// Dark-launched: writes are gated by `isUsageTrackingEnabled()`
// (`NANOCLAW_USAGE_TRACKING=1`). The DB layer always accepts writes so
// tests can exercise the schema without env shenanigans.

function initUsageSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS usage_log (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      group_folder    TEXT NOT NULL,
      session_id      TEXT,
      runner          TEXT NOT NULL,
      model           TEXT,
      ts              TEXT NOT NULL,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_read      INTEGER NOT NULL DEFAULT 0,
      cache_write     INTEGER NOT NULL DEFAULT 0,
      reasoning_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL,
      duration_ms     INTEGER,
      ttft_ms         INTEGER,
      raw_json        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_usage_log_group_ts
      ON usage_log(group_folder, ts);
    CREATE INDEX IF NOT EXISTS idx_usage_log_ts ON usage_log(ts);
    CREATE TABLE IF NOT EXISTS quota_snapshots (
      runner               TEXT NOT NULL,
      model                TEXT NOT NULL,
      ts                   TEXT NOT NULL,
      pct_remaining        REAL,
      used_requests        INTEGER,
      entitlement_requests INTEGER,
      reset_date           TEXT,
      is_unlimited         INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (runner, model)
    );
  `);
}

export interface UsageEvent {
  groupFolder: string;
  sessionId?: string | null;
  runner: 'ghc' | 'cc';
  model?: string | null;
  ts?: string; // ISO; defaults to now
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  reasoningTokens?: number;
  costUsd?: number | null;
  durationMs?: number | null;
  ttftMs?: number | null;
  rawJson?: string | null;
}

export interface UsageLogRow {
  id: number;
  groupFolder: string;
  sessionId: string | null;
  runner: 'ghc' | 'cc';
  model: string | null;
  ts: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  costUsd: number | null;
  durationMs: number | null;
  ttftMs: number | null;
  rawJson: string | null;
}

export interface QuotaSnapshot {
  runner: 'ghc' | 'cc';
  model: string;
  ts?: string;
  pctRemaining?: number | null;
  usedRequests?: number | null;
  entitlementRequests?: number | null;
  resetDate?: string | null;
  isUnlimited?: boolean;
}

export interface QuotaSnapshotRow {
  runner: 'ghc' | 'cc';
  model: string;
  ts: string;
  pctRemaining: number | null;
  usedRequests: number | null;
  entitlementRequests: number | null;
  resetDate: string | null;
  isUnlimited: boolean;
}

/**
 * Append one model-call event to `usage_log`. One row per turn / model call.
 * Returns the auto-incremented row id.
 */
export function appendUsageEvent(event: UsageEvent): number {
  const ts = event.ts ?? new Date().toISOString();
  const result = getExtDb()
    .prepare(
      `INSERT INTO usage_log (
        group_folder, session_id, runner, model, ts,
        input_tokens, output_tokens, cache_read, cache_write, reasoning_tokens,
        cost_usd, duration_ms, ttft_ms, raw_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      event.groupFolder,
      event.sessionId ?? null,
      event.runner,
      event.model ?? null,
      ts,
      event.inputTokens ?? 0,
      event.outputTokens ?? 0,
      event.cacheRead ?? 0,
      event.cacheWrite ?? 0,
      event.reasoningTokens ?? 0,
      event.costUsd ?? null,
      event.durationMs ?? null,
      event.ttftMs ?? null,
      event.rawJson ?? null,
    );
  return Number(result.lastInsertRowid);
}

function rowToUsage(row: Record<string, unknown>): UsageLogRow {
  return {
    id: row.id as number,
    groupFolder: row.group_folder as string,
    sessionId: (row.session_id as string | null) ?? null,
    runner: row.runner as 'ghc' | 'cc',
    model: (row.model as string | null) ?? null,
    ts: row.ts as string,
    inputTokens: row.input_tokens as number,
    outputTokens: row.output_tokens as number,
    cacheRead: row.cache_read as number,
    cacheWrite: row.cache_write as number,
    reasoningTokens: row.reasoning_tokens as number,
    costUsd: (row.cost_usd as number | null) ?? null,
    durationMs: (row.duration_ms as number | null) ?? null,
    ttftMs: (row.ttft_ms as number | null) ?? null,
    rawJson: (row.raw_json as string | null) ?? null,
  };
}

export function getUsageLog(
  filter: { groupFolder?: string; sinceIso?: string; limit?: number } = {},
): UsageLogRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.groupFolder) {
    clauses.push('group_folder = ?');
    params.push(filter.groupFolder);
  }
  if (filter.sinceIso) {
    clauses.push('ts >= ?');
    params.push(filter.sinceIso);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filter.limit && filter.limit > 0 ? `LIMIT ${filter.limit}` : '';
  const rows = getExtDb()
    .prepare(
      `SELECT * FROM usage_log ${where} ORDER BY ts DESC, id DESC ${limit}`,
    )
    .all(...params) as Array<Record<string, unknown>>;
  return rows.map(rowToUsage);
}

export interface UsageAggregate {
  rowCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  reasoningTokens: number;
  costUsd: number;
}

/**
 * Compute SUM/COUNT aggregates over `usage_log`, optionally filtered by
 * group + time window. NULL cost columns are excluded from the SUM (CC
 * runner doesn't supply cost), so a CC-only result correctly reports 0.
 */
export function aggregateUsage(
  filter: { groupFolder?: string; sinceIso?: string } = {},
): UsageAggregate {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.groupFolder) {
    clauses.push('group_folder = ?');
    params.push(filter.groupFolder);
  }
  if (filter.sinceIso) {
    clauses.push('ts >= ?');
    params.push(filter.sinceIso);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const row = getExtDb()
    .prepare(
      `SELECT
        COUNT(*)                          AS row_count,
        COALESCE(SUM(input_tokens), 0)    AS input_tokens,
        COALESCE(SUM(output_tokens), 0)   AS output_tokens,
        COALESCE(SUM(cache_read), 0)      AS cache_read,
        COALESCE(SUM(cache_write), 0)     AS cache_write,
        COALESCE(SUM(reasoning_tokens), 0) AS reasoning_tokens,
        COALESCE(SUM(cost_usd), 0)        AS cost_usd
      FROM usage_log ${where}`,
    )
    .get(...params) as {
    row_count: number;
    input_tokens: number;
    output_tokens: number;
    cache_read: number;
    cache_write: number;
    reasoning_tokens: number;
    cost_usd: number;
  };
  return {
    rowCount: row.row_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheRead: row.cache_read,
    cacheWrite: row.cache_write,
    reasoningTokens: row.reasoning_tokens,
    costUsd: row.cost_usd,
  };
}

/** Delete usage_log rows older than `cutoffIso`. Returns rows removed. */
export function vacuumUsageLog(cutoffIso: string): number {
  const result = getExtDb()
    .prepare('DELETE FROM usage_log WHERE ts < ?')
    .run(cutoffIso);
  return Number(result.changes);
}

/** UPSERT the latest quota snapshot for (runner, model). */
export function upsertQuotaSnapshot(snap: QuotaSnapshot): void {
  const ts = snap.ts ?? new Date().toISOString();
  getExtDb()
    .prepare(
      `INSERT INTO quota_snapshots (
        runner, model, ts, pct_remaining, used_requests,
        entitlement_requests, reset_date, is_unlimited
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(runner, model) DO UPDATE SET
        ts = excluded.ts,
        pct_remaining = excluded.pct_remaining,
        used_requests = excluded.used_requests,
        entitlement_requests = excluded.entitlement_requests,
        reset_date = excluded.reset_date,
        is_unlimited = excluded.is_unlimited`,
    )
    .run(
      snap.runner,
      snap.model,
      ts,
      snap.pctRemaining ?? null,
      snap.usedRequests ?? null,
      snap.entitlementRequests ?? null,
      snap.resetDate ?? null,
      snap.isUnlimited ? 1 : 0,
    );
}

function rowToQuota(row: Record<string, unknown>): QuotaSnapshotRow {
  return {
    runner: row.runner as 'ghc' | 'cc',
    model: row.model as string,
    ts: row.ts as string,
    pctRemaining: (row.pct_remaining as number | null) ?? null,
    usedRequests: (row.used_requests as number | null) ?? null,
    entitlementRequests: (row.entitlement_requests as number | null) ?? null,
    resetDate: (row.reset_date as string | null) ?? null,
    isUnlimited: Number(row.is_unlimited) === 1,
  };
}

export function getQuotaSnapshots(): QuotaSnapshotRow[] {
  const rows = getExtDb()
    .prepare('SELECT * FROM quota_snapshots ORDER BY runner, model')
    .all() as Array<Record<string, unknown>>;
  return rows.map(rowToQuota);
}

export function getQuotaSnapshot(
  runner: 'ghc' | 'cc',
  model: string,
): QuotaSnapshotRow | undefined {
  const row = getExtDb()
    .prepare('SELECT * FROM quota_snapshots WHERE runner = ? AND model = ?')
    .get(runner, model) as Record<string, unknown> | undefined;
  return row ? rowToQuota(row) : undefined;
}

/**
 * Phase-1 dark-launch flag. Callers (runners + IPC handlers) consult this
 * to decide whether to emit/persist usage events. Defaults OFF until the
 * flag is set explicitly. Tests that exercise the DB layer can ignore it
 * and call `appendUsageEvent()` directly.
 */
export function isUsageTrackingEnabled(): boolean {
  const v = process.env.NANOCLAW_USAGE_TRACKING;
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}
