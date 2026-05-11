/**
 * Workspace .env auto-loader.
 *
 * Why this exists (2026-05-06):
 *   `nanoclaw start` / `restart` spawn the daemon detached without a
 *   shell, so `~/.nanoclaw/.env` is never sourced. `auth.ts:isAuthenticated()`
 *   reads `.env` from disk to *report* status, but the runtime
 *   process.env is empty → token-driven channels (telegram bot,
 *   teams secret, COPILOT_GITHUB_TOKEN) silently fail at runtime.
 *
 *   The fix: every entry point that boots the daemon (or TUI, which
 *   also needs the same env) calls `loadWorkspaceEnv()` once, before
 *   any module that reads `process.env.*`.
 *
 *   Node 22 ships `process.loadEnvFile` natively, no dotenv dep.
 *
 * Idempotent: existing `process.env` keys win (CLI / shell / systemd
 * Environment= override .env file).
 */
import fs from 'fs';
import path from 'path';

let loaded = false;

export function loadWorkspaceEnv(workspace?: string): void {
  if (loaded) return;
  loaded = true;
  const ws =
    workspace ||
    process.env.NANOCLAW_WORKSPACE ||
    path.join(process.env.HOME || process.env.USERPROFILE || '', '.nanoclaw');
  const envFile = path.join(ws, '.env');
  if (!fs.existsSync(envFile)) return;

  // Node 22.6+: process.loadEnvFile (no override of existing env vars).
  const lef = (
    process as unknown as {
      loadEnvFile?: (p: string) => void;
    }
  ).loadEnvFile;
  if (typeof lef === 'function') {
    try {
      lef(envFile);
      return;
    } catch {
      /* fall through to manual parse */
    }
  }

  // Fallback parser (Node < 22.6 or loadEnvFile failure).
  try {
    const content = fs.readFileSync(envFile, 'utf-8');
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq < 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      // strip surrounding quotes
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (key && process.env[key] === undefined) {
        process.env[key] = val;
      }
    }
  } catch {
    /* best-effort */
  }
}
