/**
 * Workspace resolution for nanoclaw.
 * Default workspace dir name comes from `./workspace-config.ts` (single source of truth).
 *
 * Resolution priority: setWorkspace() > NANOCLAW_WORKSPACE env > <home>/<WORKSPACE_DIR_NAME>.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { WORKSPACE_DIR_NAME } from './workspace-config.js';

const DEFAULT_WORKSPACE = path.join(os.homedir(), WORKSPACE_DIR_NAME);

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
 * Startup guard: assert the resolved workspace basename matches the canonical
 * workspace dir name, OR was explicitly set via setWorkspace() / NANOCLAW_WORKSPACE
 * (operator opt-in). Catches accidental misroutes from stale systemd Environment=
 * or shell env values pointing at long-gone staging dirs.
 *
 * Returns the resolved workspace path on success.
 */
export function assertWorkspaceIsolation(): string {
  const resolved = resolveWorkspace();
  // If the operator explicitly opted in via env or setWorkspace(), trust them.
  // Only enforce the basename check on the auto-default path.
  if (_workspace || process.env.NANOCLAW_WORKSPACE) return resolved;
  const base = path.basename(path.resolve(resolved));
  if (base !== WORKSPACE_DIR_NAME) {
    const msg =
      `\n\x1b[31m[workspace guard] FATAL: resolved workspace basename '${base}' != '${WORKSPACE_DIR_NAME}'.\x1b[0m\n` +
      `Set NANOCLAW_WORKSPACE explicitly to opt out of the guard.\n`;
    process.stderr.write(msg);
    throw new Error(`Workspace guard tripped: basename '${base}' != '${WORKSPACE_DIR_NAME}'`);
  }
  return resolved;
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
