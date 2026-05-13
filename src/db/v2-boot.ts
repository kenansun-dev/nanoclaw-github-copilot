/**
 * v2 central DB bootstrap.
 *
 * Opens the v2 central DB at `<workspace>/store/v2.db` (separate file
 * from legacy `messages.db` to avoid double-handle-on-same-file pitfalls
 * with WAL-mode prepared-statement caches), runs migrations (the
 * v2-boot-guard inside `runMigrations` is a no-op on this fresh file
 * since it only triggers on the legacy `sessions` shape), and
 * reconciles declared config into v2 tables.
 *
 * Extracted from `index.ts main()` so the boot path is unit-testable
 * without standing up the full host process.
 */
import { loadConfig } from '../config-loader.js';
import { workspacePath } from '../workspace.js';
import { initDb } from './connection.js';
import { runMigrations } from './migrations/index.js';
import { reconcileConfigToDb } from './v2-reconcile.js';

export interface V2BootResult {
  dbPath: string;
  summary: ReturnType<typeof reconcileConfigToDb>;
}

/**
 * Initialize the v2 central DB and reconcile config → DB.
 *
 * Side effects: opens (and caches) the central DB via `initDb`, runs
 * pending migrations, and projects declared config into `agent_groups`,
 * `users`, `user_roles`, `agent_group_members`, and
 * `messaging_group_agents`.
 *
 * Re-entrant: `initDb` replaces the cached handle; `runMigrations` and
 * `reconcileConfigToDb` are idempotent.
 */
export function initAndReconcileV2(): V2BootResult {
  const dbPath = workspacePath('store', 'v2.db');
  const db = initDb(dbPath);
  runMigrations(db, dbPath);
  const cfg = loadConfig();
  const summary = reconcileConfigToDb(cfg, db);
  return { dbPath, summary };
}
