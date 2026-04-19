/**
 * nanoclaw doctor — check system dependencies and configuration.
 */

import { execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { paths, resolveWorkspace } from './workspace.js';
import { loadConfig } from './config-loader.js';
import { PACKAGE_ROOT } from './config.js';
import { isGHCProvider } from './config-extensions.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
}

export function check(
  name: string,
  fn: () => { ok: boolean; msg: string; status?: 'ok' | 'warn' | 'error' },
): CheckResult {
  try {
    const { ok, msg, status } = fn();
    return {
      name,
      status: status ?? (ok ? 'ok' : 'error'),
      message: msg,
    };
  } catch (err) {
    return {
      name,
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Pure decision logic for the "Registered chats" check. Extracted so we
 * can unit-test the severity matrix without standing up a full config.
 *
 * Severity rules:
 * - chats > 0  → ok
 * - chats = 0 + at least one channel enabled (telegram/teams accept
 *   incoming without explicit chat registration) → warn
 * - chats = 0 + no channel enabled → error (truly unconfigured)
 */
export function chatsCheck(
  chatCount: number,
  enabledChannels: string[],
): { ok: boolean; status?: 'ok' | 'warn' | 'error'; msg: string } {
  if (chatCount > 0) {
    return { ok: true, msg: `${chatCount} chat(s)` };
  }
  if (enabledChannels.length > 0) {
    return {
      ok: false,
      status: 'warn',
      msg: `0 explicit — ${enabledChannels.join(', ')} accept incoming without registration; add with: nanoclaw chat add`,
    };
  }
  return {
    ok: false,
    msg: 'none and no channels enabled — add with: nanoclaw chat add',
  };
}

/**
 * Pure decision logic for the "Main chat singleton" check.
 *
 * Multiple chats marked isMain:true all mount to the same `main/` folder
 * (chat-manager.ts:29 `if (chatConfig?.isMain) return 'main'`). The v3→v4
 * migration auto-dedupes on upgrade, but a hand-edited nanoclaw.json could
 * still introduce duplicates after the loader runs in non-throwing modes.
 * This check surfaces it as a doctor error with concrete remediation.
 *
 * Severity rules:
 * - 0 main chats → ok (warn variant: "no main chat picked" if any chats exist)
 * - 1 main chat  → ok
 * - >1 main chats → error (mount collision)
 */
export function mainChatSingletonCheck(
  mainJids: string[],
  totalChatCount: number,
): { ok: boolean; status?: 'ok' | 'warn' | 'error'; msg: string } {
  if (mainJids.length > 1) {
    return {
      ok: false,
      status: 'error',
      msg:
        `${mainJids.length} chats marked isMain — they all collide on the same main/ folder. ` +
        `Run: nanoclaw chat set-main <id> to pick one and clear the rest.`,
    };
  }
  if (mainJids.length === 1) {
    return { ok: true, msg: `1 main chat (${mainJids[0]})` };
  }
  if (totalChatCount > 0) {
    return {
      ok: false,
      status: 'warn',
      msg: 'no main chat picked — run: nanoclaw chat set-main <id>',
    };
  }
  return { ok: true, msg: 'no chats registered' };
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
        let image = config.sandbox.image;
        try {
          if (isGHCProvider()) image = 'nanoclaw-agent-ghc:latest';
        } catch {
          /* fallback to default */
        }
        const output = execSync(
          `docker images ${image} --format "{{.Repository}}:{{.Tag}}"`,
          { stdio: ['pipe', 'pipe', 'pipe'], timeout: 5000 },
        )
          .toString()
          .trim();
        return {
          ok: !!output,
          msg: output || `${image} not found — run: nanoclaw sandbox build`,
        };
      } catch (err: any) {
        return {
          ok: false,
          msg: `could not check (${err?.message ?? err})`,
        };
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

      // Check .env file
      const ws = resolveWorkspace();
      const envFile = path.join(ws, '.env');
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        const tokenLine = envContent
          .split('\n')
          .find((l) => l.startsWith('COPILOT_GITHUB_TOKEN=') && l.length > 22);
        if (tokenLine) return { ok: true, msg: 'authenticated (.env)' };
      }

      // Check ~/.copilot/ (GHC CLI's own auth storage from copilot login)
      const copilotDir = path.join(
        process.env.HOME || process.env.USERPROFILE || os.homedir(),
        '.copilot',
      );
      if (fs.existsSync(path.join(copilotDir, 'config.json'))) {
        return { ok: true, msg: 'authenticated (~/.copilot/)' };
      }

      // Check OpenClaw auth profile
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
    // Canonical format: channels.<name>.chats[]; legacy: top-level chats
    // (loadConfig normalizes both into config.chats). Surface a per-channel
    // breakdown so empty deployments aren't flagged red — telegram bots and
    // teams webhooks accept DMs/mentions without explicit chat registration,
    // so "none" is a warning, not a failure.
    const chatCount = Object.keys(config.chats).length;
    const enabledChannels = Object.entries(config.channels ?? {})
      .filter(([, c]: any[]) => c?.enabled)
      .map(([name]) => name);
    results.push(
      check('Registered chats', () => chatsCheck(chatCount, enabledChannels)),
    );

    // Main chat singleton: catches the silent mount-collision bug from
    // pre-v4 multi-isMain configs that bypass the migration (e.g. hand-
    // edited nanoclaw.json after the loader normalized things).
    const mainJids = Object.entries(config.chats)
      .filter(([, e]: any[]) => e?.isMain)
      .map(([jid]) => jid);
    results.push(
      check('Main chat singleton', () =>
        mainChatSingletonCheck(mainJids, chatCount),
      ),
    );
  } catch {
    /* ignore */
  }

  // GHC CLI
  results.push(
    check('GHC CLI', () => {
      // Check global
      try {
        execSync('copilot --version', {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        });
        return { ok: true, msg: 'installed (global)' };
      } catch {
        /* not in PATH */
      }
      // Check in agent-runner-ghc node_modules (bundled with nanoclaw)
      try {
        const localBin = path.join(
          PACKAGE_ROOT,
          'container',
          'agent-runner-ghc',
          'node_modules',
          '.bin',
          process.platform === 'win32' ? 'copilot.cmd' : 'copilot',
        );
        if (fs.existsSync(localBin)) {
          return { ok: true, msg: 'installed (bundled)' };
        }
      } catch {
        /* ignore */
      }
      return {
        ok: false,
        msg: 'not found \u2014 run: npm install -g @github/copilot',
      };
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
