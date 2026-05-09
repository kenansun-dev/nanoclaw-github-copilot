/**
 * NanoClaw preinstall backup hook.
 *
 * Runs as `preinstall` lifecycle of the npm package. Critical caveat:
 * by the time npm invokes preinstall scripts from a tarball install,
 * npm has *already* replaced the global install dir contents with the
 * new package. So this hook CANNOT capture the previously-installed
 * binary — we only get to snapshot the workspace (which lives
 * independently at `~/.nanoclaw`).
 *
 * Capture of the previous install dir is handled separately, *before*
 * the npm install kicks off:
 *   - v2→v2.next: v2's `runUpdate` calls `stashCurrentBinary` before
 *     execing `npm install -g`, which captures the v2 install dir.
 *   - v1→v2 first upgrade: v1's `runUpdate` has no such logic. There
 *     is no way for this preinstall hook to retroactively capture v1.
 *     User keeps their v1 tgz (or rebuilds from git tag) for binary
 *     rollback; otherwise `nanoclaw rollback --no-binary` restores
 *     workspace data only and leaves the v2 binary in place.
 *
 * Constraints:
 *   - Must NEVER fail the install on soft errors: catch, warn, exit 0.
 *   - Hard-fail only on disk-space pre-check (rollback would be unsafe).
 *   - No npm/devDep imports — must run in the unpacked tarball with
 *     zero deps installed.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execSync } from 'node:child_process';

const PACKAGE_NAME = 'nanoclaw-github-copilot';

function log(msg) {
  process.stderr.write(`[nanoclaw preinstall] ${msg}\n`);
}

function resolveWorkspace() {
  if (process.env.NANOCLAW_WORKSPACE) {
    return path.resolve(process.env.NANOCLAW_WORKSPACE);
  }
  const dirName = process.env.NANOCLAW_WORKSPACE_DIR || '.nanoclaw';
  return path.join(os.homedir(), dirName);
}

function defaultBackupDir() {
  return path.join(os.homedir(), '.nanoclaw.backup');
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

// Cross-platform recursive directory size in KiB. Node-only, no shell.
// Walks lazily, ignores symlinks, swallows per-entry errors so one
// permission-denied file doesn't zero the estimate.
function dirSizeKb(p) {
  let bytes = 0;
  const stack = [p];
  while (stack.length) {
    const cur = stack.pop();
    let st;
    try {
      st = fs.lstatSync(cur);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) {
      let entries = [];
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
  return Math.ceil(bytes / 1024);
}

// Cross-platform free space via fs.statfsSync (Node ≥18.15). Falls back
// to df on POSIX systems where statfsSync isn't available.
function freeKbAt(p) {
  let probe = p;
  while (probe && !fs.existsSync(probe)) probe = path.dirname(probe);
  if (typeof fs.statfsSync === 'function') {
    try {
      const s = fs.statfsSync(probe);
      return Math.floor((Number(s.bavail) * Number(s.bsize)) / 1024);
    } catch {
      /* fall through */
    }
  }
  if (process.platform !== 'win32') {
    try {
      const out = execSync(`df -Pk ${JSON.stringify(probe)}`, {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lines = out.trim().split('\n');
      const cols = lines[lines.length - 1].split(/\s+/);
      return parseInt(cols[3], 10);
    } catch {
      /* ignore */
    }
  }
  return Infinity;
}

function npmRootGlobal() {
  // npm exposes the global root via prefix env during install lifecycle.
  if (process.env.npm_config_prefix) {
    return path.join(process.env.npm_config_prefix, 'lib', 'node_modules');
  }
  return null;
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

function snapshotWorkspace(ws, backupDir) {
  const dest = path.join(backupDir, `workspace-${timestamp()}`);
  log(`snapshot workspace → ${dest}`);
  // Cross-platform: fs.cpSync (Node ≥16.7) preserves file mode/times,
  // skips symlinks correctly, and works on Windows where `cp -a` fails
  // silently. Used to use `cp -a` which is why Windows users ended up
  // with empty backup dirs (B.5 regression).
  fs.cpSync(ws, dest, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    errorOnExist: false,
    force: true,
  });
  return dest;
}

function main() {
  // Default behavior: skip the workspace snapshot. Backups are now opt-in
  // because (a) on Windows the v1 binary that triggered this hook
  // historically shelled out to `cp -a` and crashed before npm could even
  // hand control over here, and (b) most users keep their own backups /
  // don't run `nanoclaw rollback`. Set NANOCLAW_BACKUP=1 to re-enable.
  if (process.env.NANOCLAW_BACKUP !== '1') {
    if (process.env.NANOCLAW_SKIP_PREINSTALL_BACKUP === '1') {
      log('skipped (NANOCLAW_SKIP_PREINSTALL_BACKUP=1)');
    } else {
      log('skipped (default; set NANOCLAW_BACKUP=1 to enable workspace snapshot)');
    }
    return;
  }

  const ws = resolveWorkspace();
  const wsExists = fs.existsSync(ws);

  if (!wsExists) {
    log('no existing workspace at ' + ws + ' — fresh setup, nothing to back up');
    return;
  }

  const backupDir = process.env.NANOCLAW_BACKUP_DIR
    ? path.resolve(process.env.NANOCLAW_BACKUP_DIR)
    : defaultBackupDir();
  ensureDir(backupDir);

  // Pre-flight df check (workspace size × 1.2).
  const wsKb = dirSizeKb(ws);
  const need = Math.ceil(wsKb * 1.2);
  const free = freeKbAt(backupDir);
  log(
    `disk check: need ~${Math.ceil(need / 1024)} MB, free ${
      free === Infinity ? '?' : Math.ceil(free / 1024)
    } MB at ${backupDir}`,
  );
  if (free !== Infinity && free < need) {
    log(
      '❌ insufficient free disk for backup. Set NANOCLAW_BACKUP_DIR=<path> ' +
        'on a roomier filesystem, or NANOCLAW_SKIP_PREINSTALL_BACKUP=1 to ' +
        'skip (rollback will then be unavailable).',
    );
    // Hard-fail the install: better to abort cleanly than land a binary
    // with no rollback safety net.
    process.exit(1);
  }

  try {
    snapshotWorkspace(ws, backupDir);
  } catch (err) {
    log(`warn: workspace snapshot failed (${err?.message ?? err})`);
  }

  // Note: we deliberately do NOT try to capture the previous install dir
  // here. By the time npm runs preinstall scripts from a tarball install,
  // it has already replaced the global install dir with the new package
  // contents — so cp -a would just snapshot the new binary, which is
  // useless for rollback. Capture of the previous install dir is the
  // job of v2's `nanoclaw update` (`stashCurrentBinary`), which runs
  // BEFORE the `npm install -g` exec. For v1→v2 first upgrade there is
  // no such hook (v1's update.ts predates this feature) — in that case
  // workspace data is still safe via this snapshot, and binary rollback
  // requires keeping the original v1 tgz.
  const npmRoot = npmRootGlobal();
  if (npmRoot) {
    log('install dir capture skipped (already swapped by npm at preinstall time)');
  }

  log(`✅ pre-install backup done at ${backupDir}`);
}

try {
  main();
} catch (err) {
  // Never fail the install on unexpected errors.
  log(`unexpected error (continuing): ${err?.message ?? err}`);
}
