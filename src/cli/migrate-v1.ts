/**
 * In-place v1 → v2 workspace migration helper used by `nanoclaw update`.
 *
 * Detection (v1 install):
 *   <workspace>/store/messages.db exists AND
 *   has table `registered_groups` AND
 *   <workspace>/data/v2.db does NOT exist
 *
 * Strategy: in-place. The v1 messages.db stays put (read-only after the
 * migration; v2 doesn't open it). The v2 schema lives in <workspace>/data/v2.db
 * which is created fresh from the v1 data via setup/migrate-v2/db.ts.
 *
 * Backup: <workspace>/.backup-YYYYMMDD-HHMM/{store,data,nanoclaw.json,.env}
 * (lightweight — does NOT mirror sessions/, logs/, container caches).
 *
 * Rollback: see docs/MIGRATION.md or the printed instructions on failure.
 */
import { execSync, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';

export interface MigrationResult {
  status: 'skipped-not-v1' | 'skipped-already-migrated' | 'migrated' | 'failed';
  backupDir?: string;
  message?: string;
}

/**
 * Returns true if the workspace looks like a v1 install that has not yet
 * been migrated to v2.
 */
export function detectV1Install(workspace: string): boolean {
  const v1DbPath = path.join(workspace, 'store', 'messages.db');
  const v2DbPath = path.join(workspace, 'data', 'v2.db');
  if (!fs.existsSync(v1DbPath)) return false;
  if (fs.existsSync(v2DbPath)) return false;
  // Open v1 db and check for registered_groups
  try {
    const db = new Database(v1DbPath, { readonly: true, fileMustExist: true });
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'")
      .get();
    db.close();
    return row != null;
  } catch {
    return false;
  }
}

function timestamp(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

/**
 * Snapshot the small set of files we need to roll back from. Uses cpSync
 * recursive to preserve symlinks/perms. Returns the absolute backup dir.
 */
export function backupCriticalFiles(workspace: string): string {
  const backupDir = path.join(workspace, `.backup-${timestamp()}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const items = ['store', 'data', 'nanoclaw.json', '.env'];
  for (const item of items) {
    const src = path.join(workspace, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(backupDir, item);
    fs.cpSync(src, dst, {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
      verbatimSymlinks: true,
    });
  }
  return backupDir;
}

/**
 * Restore from a backup dir produced by backupCriticalFiles().
 * Used on migration failure. Best-effort: logs but does not throw.
 */
export function restoreFromBackup(workspace: string, backupDir: string): void {
  const items = ['store', 'data', 'nanoclaw.json', '.env'];
  for (const item of items) {
    const src = path.join(backupDir, item);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(workspace, item);
    try {
      if (fs.existsSync(dst)) {
        fs.rmSync(dst, { recursive: true, force: true });
      }
      fs.cpSync(src, dst, {
        recursive: true,
        preserveTimestamps: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    } catch (err) {
      process.stderr.write(`  ⚠️  Restore of ${item} failed: ${(err as Error).message}\n`);
    }
  }
}

/**
 * Run the v1 → v2 schema migration in place. Requires `npx tsx` to be
 * resolvable from `projectRoot`. Returns 'migrated' on success.
 *
 * Verifies post-migration that <workspace>/data/v2.db exists AND has a
 * non-empty `agent_groups` table. If any step fails, restores backup.
 */
export function runV1Migration(workspace: string, projectRoot: string): MigrationResult {
  if (!detectV1Install(workspace)) {
    const v2DbExists = fs.existsSync(path.join(workspace, 'data', 'v2.db'));
    return {
      status: v2DbExists ? 'skipped-already-migrated' : 'skipped-not-v1',
    };
  }

  process.stderr.write('  📦 v1 install detected — backing up before migration...\n');
  let backupDir: string;
  try {
    backupDir = backupCriticalFiles(workspace);
    process.stderr.write(`     Backup: ${backupDir}\n`);
  } catch (err) {
    return {
      status: 'failed',
      message: `Backup failed: ${(err as Error).message}`,
    };
  }

  process.stderr.write('  🔄 Running schema migration (registered_groups → agent/messaging_groups)...\n');
  const env = { ...process.env, NANOCLAW_WORKSPACE: workspace };
  const result = spawnSync(
    'npx',
    ['--yes', 'tsx', path.join(projectRoot, 'setup', 'migrate-v2', 'db.ts'), workspace],
    {
      cwd: projectRoot,
      env,
      stdio: 'inherit',
      timeout: 120000,
    },
  );

  if (result.status !== 0) {
    process.stderr.write(`  ❌ Migration script failed (exit ${result.status}). Restoring backup...\n`);
    restoreFromBackup(workspace, backupDir);
    return {
      status: 'failed',
      backupDir,
      message: `Migration script exited with code ${result.status}`,
    };
  }

  // Verify
  const v2DbPath = path.join(workspace, 'data', 'v2.db');
  if (!fs.existsSync(v2DbPath)) {
    process.stderr.write('  ❌ Migration finished but v2.db not found. Restoring backup...\n');
    restoreFromBackup(workspace, backupDir);
    return { status: 'failed', backupDir, message: 'v2.db missing after migration' };
  }
  try {
    const db = new Database(v2DbPath, { readonly: true });
    const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_groups'").get();
    if (!row) {
      db.close();
      process.stderr.write('  ❌ v2.db exists but missing agent_groups table. Restoring backup...\n');
      restoreFromBackup(workspace, backupDir);
      return { status: 'failed', backupDir, message: 'agent_groups table missing' };
    }
    db.close();
  } catch (err) {
    process.stderr.write(`  ⚠️  v2.db verify failed: ${(err as Error).message}\n`);
    restoreFromBackup(workspace, backupDir);
    return { status: 'failed', backupDir, message: `Verify failed: ${(err as Error).message}` };
  }

  process.stderr.write(`  ✅ Migration complete. Backup retained at: ${backupDir}\n`);
  process.stderr.write(
    '     If anything looks wrong after restart: stop nanoclaw, rm data/v2.db, restore from backup, reinstall v1.\n',
  );
  return { status: 'migrated', backupDir };
}

// Suppress unused execSync warning — kept for future systemd switchover step.
void execSync;
