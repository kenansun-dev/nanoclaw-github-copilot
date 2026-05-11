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

import { defaultBackupDir, listWorkspaceSnapshots, PREV_BINARY_TGZ, PREV_INSTALL_DIR } from './backup.js';

interface Options {
  backupDir: string;
  snapshot: string | null;
  keepCurrent: boolean;
  dryRun: boolean;
  yes: boolean;
  noBinary: boolean;
}

function parseArgs(args: string[]): Options {
  let backupDir = defaultBackupDir();
  let snapshot: string | null = null;
  let keepCurrent = true; // safer default — never destroy v2 data
  let dryRun = false;
  let yes = false;
  let noBinary = false;

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
    } else if (a === '--no-binary') {
      noBinary = true;
    } else if (a === '--yes' || a === '-y') {
      yes = true;
    }
  }
  return { backupDir, snapshot, keepCurrent, dryRun, yes, noBinary };
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
  const dir = path.join(opts.backupDir, PREV_INSTALL_DIR);
  // Prefer captured install dir (current default), fall back to legacy tgz.
  const haveDir = fs.existsSync(dir);
  const haveTgz = !haveDir && fs.existsSync(tgz);
  const haveBin = haveDir || haveTgz;
  const binSpec = haveDir ? dir : haveTgz ? tgz : null;
  if (!haveBin && !opts.noBinary) {
    console.error(`❌ No previous-binary artifact found in ${opts.backupDir}.`);
    console.error(`   Looked for ${PREV_INSTALL_DIR}/  (preferred)`);
    console.error(`   and        ${PREV_BINARY_TGZ}    (legacy)`);
    console.error('   The last `nanoclaw update` could not stash the prior install.');
    console.error('   Two ways forward:');
    console.error('     1. Drop a v1 tgz at <backup-dir>/nanoclaw-prev.tgz, then re-run rollback.');
    console.error('     2. `nanoclaw rollback --no-binary` — restore workspace only,');
    console.error('        keep the currently-installed binary in place.');
    process.exit(1);
  }
  if (!haveBin && opts.noBinary) {
    console.log('  --no-binary: skipping binary reinstall, restoring workspace only');
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
  console.log(`  binary     : ${binSpec ?? '(skipped — --no-binary)'}`);
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

  // Reinstall previous binary (unless --no-binary).
  if (binSpec) {
    console.log('  Reinstalling previous nanoclaw binary...');
    if (haveDir) {
      // Captured install dir: node_modules already populated (cp -a copied
      // native bindings like better_sqlite3.node), package.json already
      // defanged. Skip lifecycle scripts — nothing to gain, and the
      // defanged scripts{} block has nothing to run anyway.
      execSync(`npm install -g --ignore-scripts ${JSON.stringify(binSpec)}`, {
        stdio: 'inherit',
        timeout: 180000,
      });
    } else {
      // Legacy tgz path (user-supplied / first-upgrade fallback): the tgz
      // does NOT ship prebuilt native binaries, so lifecycle scripts MUST
      // run — specifically better-sqlite3's prebuild-install postinstall,
      // which downloads the platform-specific .node binding. Skipping it
      // leaves nanoclaw start-up dead with "Could not locate the bindings
      // file". The tgz is user-supplied: trust its scripts the same way
      // the original install did.
      execSync(`npm install -g ${JSON.stringify(binSpec)}`, {
        stdio: 'inherit',
        timeout: 300000,
      });
    }
  } else {
    console.log('  (skipping binary reinstall: --no-binary)');
  }

  // Restart.
  try {
    execSync('nanoclaw start', { stdio: 'inherit', timeout: 30000 });
    console.log('  ✅ NanoClaw restarted on previous version');
  } catch (err: any) {
    console.log(`  ⚠️  Could not auto-restart: ${err?.message ?? err}. Run: nanoclaw start`);
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
