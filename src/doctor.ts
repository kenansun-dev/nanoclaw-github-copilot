/**
 * nanoclaw doctor — check system dependencies and configuration.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { paths, resolveWorkspace } from './workspace.js';
import { loadConfig } from './config-loader.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

function check(
  name: string,
  fn: () => { ok: boolean; msg: string },
): CheckResult {
  try {
    const { ok, msg } = fn();
    return { name, status: ok ? 'ok' : 'error', message: msg };
  } catch (err) {
    return {
      name,
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

export function runDoctor(): CheckResult[] {
  const results: CheckResult[] = [];

  // Node.js
  results.push(
    check('Node.js', () => {
      const version = process.version;
      const major = parseInt(version.slice(1));
      return {
        ok: major >= 20,
        msg: `${version}${major < 20 ? ' (need >=20)' : ''}`,
      };
    }),
  );

  // Docker
  results.push(
    check('Docker', () => {
      try {
        const info = execSync('docker info --format "{{.ServerVersion}}"', {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        })
          .toString()
          .trim();
        return { ok: true, msg: `running (${info})` };
      } catch {
        return { ok: false, msg: 'not running or not installed' };
      }
    }),
  );

  // Container image
  results.push(
    check('Container image', () => {
      try {
        const config = loadConfig();
        const image = config.sandbox.image;
        const output = execSync(
          `docker images ${image} --format "{{.Repository}}:{{.Tag}}"`,
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
        )
          .toString()
          .trim();
        return {
          ok: !!output,
          msg: output || `${image} not found — run: docker build`,
        };
      } catch {
        return { ok: false, msg: 'could not check' };
      }
    }),
  );

  // Workspace
  results.push(
    check('Workspace', () => {
      const ws = resolveWorkspace();
      const exists = fs.existsSync(ws);
      return {
        ok: exists,
        msg: exists ? ws : `${ws} — not found, run: nanoclaw init`,
      };
    }),
  );

  // Config file
  results.push(
    check('Config', () => {
      if (!fs.existsSync(paths.config)) {
        return { ok: false, msg: 'nanoclaw.json not found' };
      }
      try {
        loadConfig();
        return { ok: true, msg: 'nanoclaw.json valid' };
      } catch (err) {
        return { ok: false, msg: `invalid: ${err}` };
      }
    }),
  );

  // Provider auth
  results.push(
    check('Provider: github-copilot', () => {
      // Check for token in various locations
      if (
        process.env.COPILOT_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN
      ) {
        return { ok: true, msg: 'authenticated (env token)' };
      }
      const profilePath = path.join(
        os.homedir(),
        '.openclaw/agents/main/agent/auth-profiles.json',
      );
      if (fs.existsSync(profilePath)) {
        try {
          const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          const hasGhc = Object.values(profiles.profiles || {}).some(
            (p: any) => p.provider === 'github-copilot' && p.token,
          );
          if (hasGhc)
            return { ok: true, msg: 'authenticated (OpenClaw profile)' };
        } catch {
          /* ignore */
        }
      }
      return { ok: false, msg: 'not authenticated — run: nanoclaw auth login' };
    }),
  );

  // Channels
  try {
    const config = loadConfig();

    if (config.channels.telegram.enabled) {
      results.push(
        check('Channel: telegram', () => ({
          ok: !!config.channels.telegram.botToken,
          msg: config.channels.telegram.botToken
            ? 'configured'
            : 'enabled but no bot token',
        })),
      );
    }

    if (config.channels.teams.enabled) {
      results.push(
        check('Channel: teams', () => {
          const t = config.channels.teams;
          const hasAuth = !!(t.appId && (t.appPassword || t.certThumbprint));
          return {
            ok: hasAuth,
            msg: hasAuth
              ? `configured (${t.authMode})`
              : 'enabled but missing credentials',
          };
        }),
      );
    }

    // Chats
    const chatCount = Object.keys(config.chats).length;
    results.push(
      check('Registered chats', () => ({
        ok: chatCount > 0,
        msg:
          chatCount > 0
            ? `${chatCount} chat(s)`
            : 'none — add with: nanoclaw chat add',
      })),
    );
  } catch {
    /* ignore */
  }

  // GHC CLI
  results.push(
    check('GHC CLI', () => {
      try {
        execSync('copilot --version', {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
        return { ok: true, msg: 'installed' };
      } catch {
        return { ok: false, msg: 'not found' };
      }
    }),
  );

  return results;
}

/**
 * Format doctor results for terminal output.
 */
export function formatDoctorResults(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const icon = r.status === 'ok' ? '✅' : r.status === 'warn' ? '⚠️' : '❌';
    return `${icon} ${r.name}: ${r.message}`;
  });
  return lines.join('\n');
}
