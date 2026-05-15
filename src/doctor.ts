/**
 * nanoclaw doctor — check system dependencies and configuration.
 */

import { execSync } from 'child_process';
import { createRequire } from 'module';
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
/**
 * Pure decision logic for the "Chat registry drift" doctor check.
 * Inputs are the counts/jids returned by `detectChatDrift()`.
 *
 * Severity rules:
 * - dirty=false                                 → ok ("in sync")
 * - added>0 only                                → warn (DB-only chats; reconcile will fix non-destructively)
 * - dedupedMains>0 OR mirroredToDb>0            → error (mount collision risk; surface immediately)
 */
export function chatDriftCheck(d: { added: string[]; dedupedMains: string[]; mirroredToDb: string[] }): {
  ok: boolean;
  status?: 'ok' | 'warn' | 'error';
  msg: string;
} {
  const dirty = d.added.length + d.dedupedMains.length + d.mirroredToDb.length;
  if (dirty === 0) {
    return { ok: true, msg: 'config.chats and registered_groups in sync' };
  }
  if (d.dedupedMains.length > 0 || d.mirroredToDb.length > 0) {
    return {
      ok: false,
      status: 'error',
      msg:
        `${d.dedupedMains.length} duplicate main(s), ${d.mirroredToDb.length} ` +
        `isMain mismatch(es) — chats compete for main/ mount. ` +
        'Run: nanoclaw chat reconcile',
    };
  }
  return {
    ok: false,
    status: 'warn',
    msg:
      `${d.added.length} chat(s) only in DB (no id, not in nanoclaw.json). ` +
      'Run: nanoclaw chat reconcile to backfill ids.',
  };
}

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
 * Multiple chats marked isMain DMs are allowed and intentionally collapse
 * onto a shared session per agent (see `collapseMainDmFolder` in
 * session-routing.ts). Multiple isMain *groups* are still flagged — group
 * sessions must stay isolated to prevent cross-context bleed.
 *
 * Severity rules:
 * - 0 main chats and any chats exist → warn (no main picked)
 * - >=1 main DMs (any count) and <=1 main group → ok
 * - >1 main groups → error (group session collision)
 */
export function mainChatSingletonCheck(
  mainJids: string[],
  totalChatCount: number,
  isGroupByJid: Record<string, boolean | undefined> = {},
): { ok: boolean; status?: 'ok' | 'warn' | 'error'; msg: string } {
  const mainGroups = mainJids.filter((jid) => isGroupByJid[jid] === true);
  const mainDms = mainJids.filter((jid) => isGroupByJid[jid] !== true);

  if (mainGroups.length > 1) {
    return {
      ok: false,
      status: 'error',
      msg:
        `${mainGroups.length} group chats marked isMain — group sessions must stay isolated. ` +
        `Run: nanoclaw chat set-main <id> to pick one and clear the rest. ` +
        `(Multiple isMain DMs are allowed and share a session.)`,
    };
  }
  if (mainJids.length >= 1) {
    const dmsNote = mainDms.length > 1 ? ` (${mainDms.length} DMs share session)` : '';
    return {
      ok: true,
      msg: `${mainJids.length} main chat${mainJids.length === 1 ? '' : 's'}${dmsNote}`,
    };
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
        const output = execSync(`docker images ${image} --format "{{.Repository}}:{{.Tag}}"`, {
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        })
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
      if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
        return { ok: true, msg: 'authenticated (env token)' };
      }

      // Check .env file
      const ws = resolveWorkspace();
      const envFile = path.join(ws, '.env');
      if (fs.existsSync(envFile)) {
        const envContent = fs.readFileSync(envFile, 'utf-8');
        const tokenLine = envContent.split('\n').find((l) => l.startsWith('COPILOT_GITHUB_TOKEN=') && l.length > 22);
        if (tokenLine) return { ok: true, msg: 'authenticated (.env)' };
      }

      // Check ~/.copilot/ (GHC CLI's own auth storage from copilot login)
      const copilotDir = path.join(process.env.HOME || process.env.USERPROFILE || os.homedir(), '.copilot');
      if (fs.existsSync(path.join(copilotDir, 'config.json'))) {
        return { ok: true, msg: 'authenticated (~/.copilot/)' };
      }

      // Check OpenClaw auth profile
      const profilePath = path.join(os.homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
      if (fs.existsSync(profilePath)) {
        try {
          const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          const hasGhc = Object.values(profiles.profiles || {}).some(
            (p: any) => p.provider === 'github-copilot' && p.token,
          );
          if (hasGhc) return { ok: true, msg: 'authenticated (OpenClaw profile)' };
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
          msg: config.channels.telegram.botToken ? 'configured' : 'enabled but no bot token',
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
            msg: hasAuth ? `configured (${t.authMode})` : 'enabled but missing credentials',
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
    results.push(check('Registered chats', () => chatsCheck(chatCount, enabledChannels)));

    // Default-agent singleton: catches the silent mount-collision bug for
    // group chats. Multiple default-agent DMs are allowed and intentionally
    // share a session (see session-routing.ts).
    //
    // Post-PR #49 (Path A v1 isMain removal): source mainJids from the v2
    // helper applied over registered_groups (single source of truth) instead
    // of the deprecated `config.chats[].isMain` field.
    let mainJids: string[] = [];
    let isGroupByJid: Record<string, boolean | undefined> = {};
    try {
      const { isDefaultAgentDmFolder } = require('./session-routing.js');
      const { getAllRegisteredGroups, getAllChats } = require('./db.js');
      const groups = getAllRegisteredGroups() as Record<string, { folder: string }>;
      // Use pattern check (literal 'main' + `main(-<agent>)?-<channel>-<8hex>`)
      // because DB folders for default-agent DMs are unique-per-jid
      // (`uniqueIsMainFolder`); strict-equality `folderIsDefaultAgent` would
      // miss them. Pattern matches the same set the share-main collapse
      // recognizes at read time.
      mainJids = Object.entries(groups)
        .filter(([, g]) => isDefaultAgentDmFolder(g.folder))
        .map(([jid]) => jid);
      const allChats = getAllChats() as Array<{
        jid: string;
        is_group?: number | null;
      }>;
      for (const c of allChats) {
        isGroupByJid[c.jid] = c.is_group === null || c.is_group === undefined ? undefined : c.is_group === 1;
      }
    } catch {
      /* db not ready — fall back to no info, conservative warn */
    }
    results.push(check('Main chat singleton', () => mainChatSingletonCheck(mainJids, chatCount, isGroupByJid)));

    // Phase 1 chat-metadata cutover (proposal 2026-05-16) drift counter.
    // F4 from VM review: doctor itself walks the facade so it can't see
    // drift via warn-on-mismatch. Compare v1 + v2 directly here and surface
    // a dedicated diagnostic line.
    results.push(
      check('Chat metadata v1↔v2 drift', () => {
        try {
          const { getAllRegisteredGroups } = require('./db.js');
          const { getAllRegisteredGroupsV2, compareV1V2ChatMetadata } = require('./db/v2-chat-metadata.js');
          const v1 = getAllRegisteredGroups();
          const v2 = getAllRegisteredGroupsV2();
          const drift = compareV1V2ChatMetadata(v1, v2);
          const total = drift.v1OnlyJids.length + drift.v2OnlyJids.length + drift.fieldMismatchJids.length;
          if (total === 0) {
            return { ok: true, msg: 'v1 ↔ v2 chat metadata in sync' };
          }
          return {
            ok: false,
            msg: `chat-metadata drift: ${drift.v1OnlyJids.length} v1-only, ${drift.v2OnlyJids.length} v2-only, ${drift.fieldMismatchJids.length} field mismatch`,
          };
        } catch (err) {
          return { ok: true, msg: `v2 chat metadata not initialized (${(err as Error).message})` };
        }
      }),
    );

    // Chat registry drift: catches the production bug found post-PR-#14
    // deploy where inbound-registered chats live only in registered_groups
    // and silently bypass the singleton invariant. Dry-run reconcile, no
    // writes — points at `nanoclaw chat reconcile` for the actual fix.
    try {
      // runDoctor is sync; chat-reconcile is fork-only ESM, so use
      // createRequire for a sync load instead of converting the whole
      // function (and 4+ tests) to async.
      const req = createRequire(import.meta.url);
      const { detectChatDrift } = req('./chat-reconcile.js');
      const drift = detectChatDrift();
      results.push(check('Chat registry drift', () => chatDriftCheck(drift)));
    } catch {
      /* DB unavailable or chat-reconcile not built; skip silently */
    }
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
