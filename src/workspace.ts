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
 * Backward-compat shims. The v2-merge staging guard + seed copy logic
 * was removed once `WORKSPACE_DIR_NAME` defaulted back to `.nanoclaw`
 * (in-place upgrade with no path split). Kept as no-ops so existing
 * call sites in `index.ts` keep compiling without churn; will be
 * deleted in a future cleanup.
 */
export function assertWorkspaceIsolation(): string {
  return resolveWorkspace();
}
export function seedV2FromV1IfNeeded(): boolean {
  return false;
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
    // B.5 + 2026-05-09 followup: file logging is daily-rotated
    // (`nanoclaw-YYYY-MM-DD.log`). Report today's daily file so
    // `/status`, `nanoclaw status`, and `nanoclaw logs` all point at
    // the file the daemon is actually writing to. Pure path math, no
    // file-system / module-load side effects (avoids circular dep on
    // log-file-sink which imports this module).
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return workspacePath('logs', `nanoclaw-${yyyy}-${mm}-${dd}.log`);
  },
};
