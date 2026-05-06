/**
 * nanoclaw rollback — restore the previously-installed nanoclaw binary
 * and workspace snapshot taken by the last `nanoclaw update`.
 *
 * Usage:
 *   nanoclaw rollback                          — newest backup in default dir
 *   nanoclaw rollback --backup-dir <path>      — pick backup root
 *   nanoclaw rollback --to <workspace-snap>    — restore a specific snapshot
 *   nanoclaw rollback --keep-current           — keep current ws as
 *                                                 ~/.nanoclaw.v2-keep-<ts>
 *                                                 instead of replacing it
 *   nanoclaw rollback --dry-run                — print plan, do nothing
 *
 * Layout the rollback expects (created by `nanoclaw update`):
 *   <backup-dir>/nanoclaw-prev.tgz          (npm pack of previous install)
 *   <backup-dir>/workspace-YYYYMMDD-HHMMSS/ (cp -a snapshot)
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  defaultBackupDir,
  listWorkspaceSnapshots,
  PREV_BINARY_TGZ,
} from './backup.js';

interface Options {
  backupDir: string;
  snapshot: string | null;
  keepCurrent: boolean;
  dryRun: boolean;
  yes: boolean;
}

function parseArgs(args: string[]): Options {
  let backupDir = defaultBackupDir();
  let snapshot: string | null = null;
  let keepCurrent = true; // safer default — never destroy v2 data
  let dryRun = false;
  let yes = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--backup-dir' && args[i + 1]) {
      backupDir = path.resolve(args[++i]);
    } else if (a === '--to' && args[i + 1]) {
      snapshot = path.resolve(args[++i]);
    } else if (a === '--keep-current') {
      keepCurrent = true;
    } else if (a === '--no-keep-current') {
      keepCurrent = false;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--yes' || a === '-y') {
      yes = true;
    }
  }
  return { backupDir, snapshot, keepCurrent, dryRun, yes };
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

export async function runRollback(args: string[]): Promise<void> {
  const opts = parseArgs(args);

  if (!fs.existsSync(opts.backupDir)) {
    console.error(`❌ Backup dir not found: ${opts.backupDir}`);
    console.error('   Pass --backup-dir to point at the right location, or run');
    console.error('   `nanoclaw update --package <tgz>` first to generate one.');
    process.exit(1);
  }

  const tgz = path.join(opts.backupDir, PREV_BINARY_TGZ);
  if (!fs.existsSync(tgz)) {
    console.error(`❌ ${PREV_BINARY_TGZ} not found in ${opts.backupDir}.`);
    console.error('   Cannot reinstall the previous binary automatically.');
    console.error('   You can still restore the workspace snapshot manually.');
    process.exit(1);
  }

  let snapshot: string;
  if (opts.snapshot) {
    if (!fs.existsSync(opts.snapshot)) {
      console.error(`❌ Snapshot not found: ${opts.snapshot}`);
      process.exit(1);
    }
    snapshot = opts.snapshot;
  } else {
    const snaps = listWorkspaceSnapshots(opts.backupDir);
    if (snaps.length === 0) {
      console.error(`❌ No workspace snapshots in ${opts.backupDir}.`);
      process.exit(1);
    }
    snapshot = snaps[0];
  }

  const { resolveWorkspace } = await import('../workspace.js');
  const ws = resolveWorkspace();
  const sideStash = `${ws}.v2-keep-${timestamp()}`;

  console.log('🔁 NanoClaw rollback plan');
  console.log(`  backup dir : ${opts.backupDir}`);
  console.log(`  binary     : ${tgz}`);
  console.log(`  snapshot   : ${snapshot}`);
  console.log(`  workspace  : ${ws}`);
  if (opts.keepCurrent) {
    console.log(`  current ws : MOVE → ${sideStash} (preserves v2-era data)`);
  } else {
    console.log(`  current ws : DELETE (data written under v2 will be lost)`);
  }
  console.log('');

  if (opts.dryRun) {
    console.log('--dry-run: no changes made.');
    return;
  }

  // Stop running daemon (best-effort).
  try {
    execSync('nanoclaw stop', { stdio: 'inherit', timeout: 15000 });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    if (!/Not running/i.test(msg)) {
      console.log(`  (stop reported: ${msg})`);
    }
  }

  // Move/remove current workspace.
  if (fs.existsSync(ws)) {
    if (opts.keepCurrent) {
      fs.renameSync(ws, sideStash);
      console.log(`  Moved current workspace → ${sideStash}`);
    } else {
      fs.rmSync(ws, { recursive: true, force: true });
      console.log('  Removed current workspace');
    }
  }

  // Restore snapshot via cp -a (preserves perms/symlinks).
  execSync(`cp -a ${JSON.stringify(snapshot)} ${JSON.stringify(ws)}`, {
    stdio: 'inherit',
  });
  console.log(`  Restored workspace from ${snapshot}`);

  // Reinstall previous binary.
  console.log('  Reinstalling previous nanoclaw binary...');
  execSync(`npm install -g ${JSON.stringify(tgz)}`, {
    stdio: 'inherit',
    timeout: 180000,
  });

  // Restart.
  try {
    execSync('nanoclaw start', { stdio: 'inherit', timeout: 30000 });
    console.log('  ✅ NanoClaw restarted on previous version');
  } catch (err: any) {
    console.log(
      `  ⚠️  Could not auto-restart: ${err?.message ?? err}. Run: nanoclaw start`,
    );
  }

  console.log('');
  console.log('✅ Rollback complete.');
  if (opts.keepCurrent) {
    console.log(`   Post-rollback v2 workspace preserved at: ${sideStash}`);
    console.log('   To go forward again, re-run `nanoclaw update --package <v2.tgz>`');
    console.log(`   then merge anything you want from ${sideStash}.`);
  }

  // Silence unused-import warning when os module no longer needed elsewhere.
  void os.homedir;
}
