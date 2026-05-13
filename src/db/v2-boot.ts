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
import { migrateChatsToV2 } from './v2-migrate-chats.js';
import { reconcileConfigToDb } from './v2-reconcile.js';

export interface V2BootResult {
  dbPath: string;
  migrate: ReturnType<typeof migrateChatsToV2>;
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
  // Auto-migrate legacy v1 config (chats[]) → v2 shape (bindings[],
  // accounts.<k>.allowFrom, commands.ownerAllowFrom). Idempotent: no-op
  // when config has no `chats[]`. Snapshots nanoclaw.json before mutating.
  const cfgForMigrate = loadConfig();
  const migrate = migrateChatsToV2(cfgForMigrate, db);
  // Re-load after migrate so reconcile sees the updated config (saveConfig
  // writes to disk during migrate).
  const cfg = migrate.noop ? cfgForMigrate : loadConfig();
  const summary = reconcileConfigToDb(cfg, db);
  return { dbPath, migrate, summary };
}
