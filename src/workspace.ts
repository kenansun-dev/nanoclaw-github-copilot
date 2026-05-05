/**
 * Workspace resolution for nanoclaw.
 * Default workspace dir name comes from `./workspace-config.ts` (single source of truth).
 * On v2-merge branch the constant resolves to `~/.nanoclaw-v2` to keep v2 staging
 * physically isolated from v1 prod data in `~/.nanoclaw`.
 *
 * Resolution priority: setWorkspace() > NANOCLAW_WORKSPACE env > <home>/<WORKSPACE_DIR_NAME>.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { WORKSPACE_DIR_NAME, LEGACY_WORKSPACE_DIR_NAME } from './workspace-config.js';

const DEFAULT_WORKSPACE = path.join(os.homedir(), WORKSPACE_DIR_NAME);
const LEGACY_WORKSPACE = path.join(os.homedir(), LEGACY_WORKSPACE_DIR_NAME);

let _workspace: string | null = null;

/**
 * Set the workspace path (called from CLI --workspace flag, or tests).
 * Pass an empty string to clear and fall back to env var / default resolution.
 */
export function setWorkspace(dir: string): void {
  _workspace = dir ? path.resolve(dir) : null;
}

/**
 * Resolve the workspace directory.
 * Priority: setWorkspace() > NANOCLAW_WORKSPACE env > <home>/<WORKSPACE_DIR_NAME>.
 */
export function resolveWorkspace(): string {
  if (_workspace) return _workspace;
  return process.env.NANOCLAW_WORKSPACE || DEFAULT_WORKSPACE;
}

/**
 * Startup guard: assert the resolved workspace is NOT the legacy v1 path.
 *
 * v2 builds must never read/write `~/.nanoclaw/` (v1 prod data). If a stray
 * --workspace flag or env var routes us there, abort hard with a red message
 * before any side effects can hit v1 data.
 *
 * Returns the resolved workspace path on success.
 * Throws (and logs to stderr) if the resolved path equals the legacy v1 path.
 */
export function assertWorkspaceIsolation(): string {
  const resolved = resolveWorkspace();
  const resolvedAbs = path.resolve(resolved);
  const legacyAbs = path.resolve(LEGACY_WORKSPACE);
  if (resolvedAbs === legacyAbs) {
    const msg =
      `\n\x1b[31m[v2 workspace guard] FATAL: workspace resolved to legacy v1 path ${legacyAbs}.\x1b[0m\n` +
      `v2 builds must use ${DEFAULT_WORKSPACE} (or another non-v1 path).\n` +
      `Check: --workspace flag, NANOCLAW_WORKSPACE env var, systemd unit Environment=.\n`;
    process.stderr.write(msg);
    throw new Error(`Workspace guard tripped: refusing to run v2 build against v1 path ${legacyAbs}`);
  }
  return resolved;
}

/**
 * First-run bootstrap: if the v2 workspace dir does not exist but the legacy v1
 * dir does, seed the v2 dir from v1 with a recursive copy. Idempotent: no-op if
 * v2 dir already exists. Returns true if a seed copy ran.
 *
 * Intentionally a synchronous best-effort copy — if it fails, log a warning
 * and let `ensureWorkspace()` create an empty v2 dir as fallback. The user can
 * always re-seed manually with `cp -a`.
 */
export function seedV2FromV1IfNeeded(): boolean {
  const v2 = DEFAULT_WORKSPACE;
  const v1 = LEGACY_WORKSPACE;
  if (fs.existsSync(v2)) return false;
  if (!fs.existsSync(v1)) return false;
  try {
    process.stderr.write(`\n[v2 workspace] First run detected. Seeding ${v2} from ${v1} (cp -a)...\n`);
    // Use fs.cpSync (Node 16.7+) for recursive copy preserving perms/symlinks.
    fs.cpSync(v1, v2, {
      recursive: true,
      preserveTimestamps: true,
      // dereference: false → preserve symlinks rather than follow them.
      dereference: false,
      // verbatimSymlinks: true → keep symlink targets exactly as written.
      verbatimSymlinks: true,
    });
    process.stderr.write(`[v2 workspace] Seed complete: ${v2}\n\n`);
    return true;
  } catch (err) {
    process.stderr.write(
      `[v2 workspace] WARN: seed copy failed (${(err as Error).message}). ` +
        `Continuing with empty workspace; re-seed manually with: cp -a ${v1} ${v2}\n`,
    );
    return false;
  }
}

/**
 * Resolve a path relative to the workspace.
 */
export function workspacePath(...segments: string[]): string {
  return path.join(resolveWorkspace(), ...segments);
}

/**
 * Ensure workspace directory exists with correct structure.
 * Returns true if workspace was just created (first run).
 */
export function ensureWorkspace(): boolean {
  const ws = resolveWorkspace();
  const isNew = !fs.existsSync(ws);

  const dirs = [
    ws,
    path.join(ws, 'skills'),
    path.join(ws, 'credentials'),
    path.join(ws, 'state'),
    path.join(ws, 'state', 'groups'),
    path.join(ws, 'docs'),
    path.join(ws, 'logs'),
  ];

  for (const dir of dirs) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Ensure credentials dir has restricted permissions
  try {
    if (process.platform !== 'win32') {
      fs.chmodSync(path.join(ws, 'credentials'), 0o700);
    }
  } catch {
    // ignore on Windows
  }

  return isNew;
}

// Well-known workspace paths
export const paths = {
  get config() {
    return workspacePath('nanoclaw.json');
  },
  get env() {
    return workspacePath('.env');
  },
  get agent() {
    return workspacePath('AGENT.md');
  },
  get skills() {
    return workspacePath('skills');
  },
  get credentials() {
    return workspacePath('credentials');
  },
  get state() {
    return workspacePath('state');
  },
  get docs() {
    return workspacePath('docs');
  },
  get mcpConfig() {
    return workspacePath('mcp.json');
  },
  get mcpTokens() {
    return workspacePath('credentials', 'mcp-tokens.json');
  },
  get pidFile() {
    return workspacePath('state', 'nanoclaw.pid');
  },
  get logFile() {
    return workspacePath('logs', 'nanoclaw.log');
  },
};
