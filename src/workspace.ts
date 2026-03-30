/**
 * Workspace resolution for nanoclaw.
 * Default: ~/.nanoclaw/ — overridable via NANOCLAW_WORKSPACE env var or --workspace CLI flag.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_WORKSPACE = path.join(os.homedir(), '.nanoclaw');

let _workspace: string | null = null;

/**
 * Set the workspace path (called from CLI --workspace flag).
 */
export function setWorkspace(dir: string): void {
  _workspace = path.resolve(dir);
}

/**
 * Resolve the workspace directory.
 * Priority: setWorkspace() > NANOCLAW_WORKSPACE env > ~/.nanoclaw/
 */
export function resolveWorkspace(): string {
  if (_workspace) return _workspace;
  return process.env.NANOCLAW_WORKSPACE || DEFAULT_WORKSPACE;
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
