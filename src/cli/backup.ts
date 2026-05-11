/**
 * Backup helpers for `nanoclaw update` / `nanoclaw rollback`.
 *
 * Naming convention (designed to be reusable across version bumps,
 * not just v1→v2):
 *   <backup-dir>/nanoclaw-prev.tgz                — the previously installed
 *                                                   binary, captured via `npm pack`
 *                                                   from the live install dir.
 *   <backup-dir>/workspace-<ts>/                  — `cp -a` snapshot of the
 *                                                   workspace just before
 *                                                   the new binary is laid down.
 *
 * `<ts>` is `YYYYMMDD-HHMMSS` (local time). New backups never overwrite
 * older ones; rollback picks the most recent one by default.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { resolveWorkspace } from '../workspace.js';

export const PREV_BINARY_TGZ = 'nanoclaw-prev.tgz';
export const PREV_INSTALL_DIR = 'nanoclaw-prev-install';
const WORKSPACE_PREFIX = 'workspace-';

export function defaultBackupDir(): string {
  // Sibling of the workspace, hidden, deterministic.
  const ws = resolveWorkspace();
  const home = os.homedir();
  const wsBase = path.basename(ws);
  // If workspace lives under $HOME use `~/.nanoclaw.backup`; otherwise drop
  // the backup dir next to the workspace as `<ws>.backup`.
  if (path.dirname(ws) === home) {
    return path.join(home, `${wsBase}.backup`);
  }
  return `${ws}.backup`;
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

/** Bytes used by a directory tree (best-effort, follows symlinks). */
export function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0;
  let bytes = 0;
  const stack = [dir];
  while (stack.length) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let entries: string[] = [];
      try {
        entries = fs.readdirSync(cur);
      } catch {
        continue;
      }
      for (const e of entries) stack.push(path.join(cur, e));
    } else if (st.isFile()) {
      bytes += st.size;
    }
  }
  return bytes;
}

/** Free bytes available on the filesystem holding `dir` (or its parent). */
export function freeBytesAt(dir: string): number {
  let probe = fs.existsSync(dir) ? dir : path.dirname(dir);
  // Node ≥18.15 fs.statfsSync is cross-platform incl. Windows.
  const statfs = (fs as unknown as { statfsSync?: (p: string) => { bavail: bigint | number; bsize: bigint | number } })
    .statfsSync;
  if (typeof statfs === 'function') {
    try {
      const s = statfs(probe);
      return Number(s.bavail) * Number(s.bsize);
    } catch {
      /* fall through */
    }
  }
  if (process.platform !== 'win32') {
    try {
      const out = execSync(`df -PB1 ${JSON.stringify(probe)}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lines = out.trim().split('\n');
      const cols = lines[lines.length - 1].split(/\s+/);
      return parseInt(cols[3], 10) || 0;
    } catch {
      /* fall through */
    }
  }
  return Number.POSITIVE_INFINITY;
}

export function ensureBackupDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Snapshot the workspace into `<backupDir>/workspace-<ts>/` using `cp -a`.
 * Returns the absolute path of the new snapshot dir.
 */
export function snapshotWorkspace(backupDir: string): string {
  const ws = resolveWorkspace();
  if (!fs.existsSync(ws)) {
    throw new Error(`workspace does not exist: ${ws}`);
  }
  ensureBackupDir(backupDir);
  const dest = path.join(backupDir, `${WORKSPACE_PREFIX}${timestamp()}`);
  // Cross-platform copy. Used to be `cp -a` which silently failed on
  // Windows (B.5 regression that left users with empty backup dirs).
  fs.cpSync(ws, dest, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });
  return dest;
}

/**
 * Capture the currently-installed nanoclaw npm package by `cp -a`'ing the
 * install directory into `<backupDir>/nanoclaw-prev-install/`. We avoid
 * `npm pack` because the upstream package's `prepare`/`prepack` scripts
 * (e.g. husky, write-build-info.mjs) run in the install dir's context,
 * have unmet dev deps, and explode — even with --ignore-scripts.
 *
 * `npm install -g <dir>` accepts a plain directory containing package.json,
 * so the rollback path doesn't need a real tarball.
 *
 * Returns the absolute path of the captured install dir, or null on failure.
 */
export function stashCurrentBinary(backupDir: string): string | null {
  ensureBackupDir(backupDir);
  let installDir: string;
  try {
    const root = execSync('npm root -g', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    installDir = path.join(root, 'nanoclaw-github-copilot');
    if (!fs.existsSync(installDir)) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const dest = path.join(backupDir, PREV_INSTALL_DIR);
    if (fs.existsSync(dest)) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.cpSync(installDir, dest, {
      recursive: true,
      preserveTimestamps: true,
      dereference: false,
      errorOnExist: false,
      force: true,
    });
    // Defang the captured package.json: npm runs `prepare`/`prepack` for
    // local-dir installs even with --ignore-scripts in some versions, and
    // they reference dev-only deps (husky) that aren't present in an end-user
    // install — leaving rollback unable to reinstall. We ship dist/ already,
    // so build/lifecycle hooks are unnecessary on rollback.
    const pkgPath = path.join(dest, 'package.json');
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      if (pkg.scripts) {
        for (const k of [
          'prepare',
          'prepack',
          'prepublish',
          'prepublishOnly',
          'preinstall',
          'install',
          'postinstall',
          'prebuild',
          'build',
        ]) {
          delete pkg.scripts[k];
        }
      }
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
    } catch (err: any) {
      process.stderr.write(
        `  ⚠️  Could not defang package.json (${err?.message ?? err}); rollback may need --ignore-scripts manually\n`,
      );
    }
    return dest;
  } catch (err: any) {
    process.stderr.write(`  ⚠️  Capture of current install dir failed: ${err?.message ?? err}\n`);
    return null;
  }
}

/**
 * List existing workspace snapshots inside `backupDir`, newest first.
 */
export function listWorkspaceSnapshots(backupDir: string): string[] {
  if (!fs.existsSync(backupDir)) return [];
  return fs
    .readdirSync(backupDir)
    .filter((n) => n.startsWith(WORKSPACE_PREFIX))
    .map((n) => path.join(backupDir, n))
    .sort()
    .reverse();
}

export function humanBytes(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}
