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
  try {
    const out = execSync(`du -sb ${JSON.stringify(dir)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseInt(out.split(/\s+/)[0], 10) || 0;
  } catch {
    return 0;
  }
}

/** Free bytes available on the filesystem holding `dir` (or its parent). */
export function freeBytesAt(dir: string): number {
  const probe = fs.existsSync(dir) ? dir : path.dirname(dir);
  try {
    const out = execSync(`df -PB1 ${JSON.stringify(probe)}`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const lines = out.trim().split('\n');
    const cols = lines[lines.length - 1].split(/\s+/);
    // Filesystem 1B-blocks Used Available Capacity Mounted-on
    return parseInt(cols[3], 10) || 0;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
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
  // cp -a preserves perms, symlinks, timestamps. Faster + simpler than fs.cpSync.
  execSync(`cp -a ${JSON.stringify(ws)} ${JSON.stringify(dest)}`, {
    stdio: 'inherit',
  });
  return dest;
}

/**
 * Capture the currently-installed nanoclaw npm package as a tarball
 * at `<backupDir>/nanoclaw-prev.tgz`. Overwrites any existing file with
 * the same name (only the latest "previous" binary is needed for rollback).
 *
 * Returns the absolute path of the tarball, or null on failure.
 */
export function stashCurrentBinary(backupDir: string): string | null {
  ensureBackupDir(backupDir);
  // Resolve install dir of the currently running nanoclaw package.
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
    // npm pack writes to cwd; do it in a temp dir then move.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-prev-'));
    // --ignore-scripts: skip the upstream package's own `prepack` (which runs
    // a full `npm run build` and may reference dev-only scripts not shipped in
    // the install). The install dir already has dist/; we just need to wrap it.
    const out = execSync(
      `npm pack --ignore-scripts ${JSON.stringify(installDir)}`,
      {
        cwd: tmp,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    const created = out.trim().split('\n').pop() || '';
    const src = path.join(tmp, created);
    if (!fs.existsSync(src)) return null;
    const dest = path.join(backupDir, PREV_BINARY_TGZ);
    fs.copyFileSync(src, dest);
    fs.rmSync(tmp, { recursive: true, force: true });
    return dest;
  } catch (err: any) {
    process.stderr.write(`  ⚠️  npm pack of current install failed: ${err?.message ?? err}\n`);
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
