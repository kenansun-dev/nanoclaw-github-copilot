/**
 * status-text.ts — shared formatter for `nanoclaw status` output.
 *
 * Originally inlined inside `runService('status')` in src/cli.ts. Extracted
 * 2026-04-23 so the slash-command handler can render the same text directly
 * to chat instead of bouncing the request through the LLM (which made
 * `/status` round-trip ~5-10s on Teams/Telegram for what is effectively a
 * synchronous file-read).
 *
 * Design rules:
 *   - **No execSync, no network, no LLM.** Read files only. Must complete
 *     in <50ms so a chat-bound caller can `await` it inline without UX cost.
 *   - **No console.log side effects.** Return a string; the caller decides
 *     whether to print to stdout (CLI) or send to chat (slash command).
 *   - **No throws on missing data.** Every section degrades to "unknown" /
 *     "not configured" rather than blowing up — the status command is
 *     itself a diagnostic; it has to work even when things are broken.
 */

import fs, { existsSync } from 'fs';
import path, { dirname, join } from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { parseJsonc } from '../jsonc.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

export interface StatusInfo {
  version: string;
  running: boolean;
  pid: string;
  uptimeStr: string;
  model: string;
  thinkLevel: string | undefined;
  showThinking: boolean | 'on' | 'off' | 'flash' | undefined;
  mode: string;
  agentName: string;
  provider: string;
  hasAuth: boolean;
  authLabel: string;
  channels: string[];
  chatCount: number;
  tunnelRunning: boolean;
  workspace: string;
  /** Workspace logs directory. The active log file rotates daily
   * (`nanoclaw-YYYY-MM-DD.log`) and gets gzipped after a week, so
   * `/status` shows the directory and lets users discover the
   * current/archived files themselves. */
  logDir: string;
  /** When chatJid was supplied, true if any field came from the per-session
   * sessions-table override (instead of the global agents.defaults config). */
  hasSessionOverride?: boolean;
  /** Names of fields overridden by the session row (model/thinkLevel/showThinking). */
  sessionOverrideFields?: string[];
  /** When chatJid was supplied, the chat the status is scoped to. */
  chatJid?: string;
}

/**
 * Collect status — fast file-only read. ~5-30ms on a warm Pi.
 *
 * @param chatJid — optional. When provided, model/thinkLevel/showThinking
 *   reflect the per-session sessions-table override for that chat (set via
 *   slash `/model`, `/think`, `/reasoning`). Falls through to global config
 *   when no override exists. When omitted, only global defaults are read —
 *   used by the CLI `nanoclaw status` which has no chat context.
 */
export async function collectStatus(chatJid?: string): Promise<StatusInfo> {
  const { resolveWorkspace } = await import('../workspace.js');
  const { loadConfig } = await import('../config-loader.js');
  const { resolveGithubToken, isCopilotAuthenticated } = await import('../config-extensions.js');

  const ws = resolveWorkspace();
  const pidFile = join(ws, 'state', 'nanoclaw.pid');
  // B.5 + 2026-05-09 followup: daily-rotated daemon log
  // (`nanoclaw-YYYY-MM-DD.log`). `/status` displays the logs *directory*
  // (kenan, 2026-05-09 — "显示 log 文件夹即可，让用户自己找");
  // `nanoclaw logs` still reads `paths.logFile` directly to tail the
  // current daily file.
  const { paths: wsPaths } = await import('../workspace.js');
  const logDir = wsPaths.logDir;

  const cfg = loadConfig();
  // Resolve the agent the way the runner does: per-chat binding (or chat.agentId)
  // first, then fall back to agents.defaults. Without this, /status in a sandbox
  // bot's chat shows the global default's mode/provider/model instead of the
  // bot's actual config (kenan repro 2026-05-05: sandbox TG bot showed Mode: host).
  let agent: any = cfg.agents?.defaults || {};
  if (chatJid) {
    try {
      const { resolveAgentForChat } = await import('../config-extensions.js');
      agent = resolveAgentForChat(chatJid) as any;
    } catch {
      /* fall back to defaults */
    }
  }
  const provider = agent.provider || 'github-copilot';
  let model = agent.model || 'default';
  const mode = agent.mode || 'host';
  const agentName = agent.name || 'NanoClaw';
  let thinkLevel = agent.thinkLevel;
  let showThinking = agent.showThinking;

  // When called from a slash-command in a chat, surface the session-scoped
  // effective values that the runner actually uses on the next message,
  // not the bare global config. Without this, `/status` keeps showing the
  // OLD global values after the user ran `/model X` (per-session) because
  // PR #27 writes overrides into the sessions table, not into the config.
  const overrideFields: string[] = [];
  if (chatJid) {
    try {
      const { getEffectiveModel, getEffectiveThinkLevel, getEffectiveShowThinking, resolveSessionScope } =
        await import('../session-overrides.js');
      const { getSessionOverrides } = await import('../db.js');
      const scope = resolveSessionScope(chatJid);
      const ov = scope ? getSessionOverrides(scope.groupFolder, scope.provider) : {};
      const eModel = getEffectiveModel(chatJid);
      if (eModel) model = eModel;
      const eThink = getEffectiveThinkLevel(chatJid);
      if (eThink !== undefined) thinkLevel = eThink === 'off' ? undefined : eThink;
      const eShow = getEffectiveShowThinking(chatJid);
      if (eShow !== undefined) showThinking = eShow;
      if (ov.model) overrideFields.push('model');
      if (ov.thinkLevel) overrideFields.push('think');
      if (ov.showThinking) overrideFields.push('reasoning');
    } catch {
      /* if session-overrides module fails for any reason fall back to
         global config — status must never throw. */
    }
  }

  // Running status from PID file
  let running = false;
  let pid = '';
  let uptimeStr = '';
  if (existsSync(pidFile)) {
    pid = fs.readFileSync(pidFile, 'utf-8').trim();
    try {
      process.kill(parseInt(pid), 0);
      running = true;
      const pidStat = fs.statSync(pidFile);
      const elapsed = Date.now() - pidStat.mtimeMs;
      const hours = Math.floor(elapsed / 3600000);
      const mins = Math.floor((elapsed % 3600000) / 60000);
      uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    } catch {
      running = false;
    }
  }

  // Auth status (mirror cli.ts logic exactly so output matches `nanoclaw status`)
  const token = resolveGithubToken();
  let hasAuth = !!token;
  let authLabel = '';
  if (token) {
    authLabel = `${provider} (${token.substring(0, 4)}****)`;
  } else {
    try {
      const copilotConfig = path.join(os.homedir(), '.copilot', 'config.json');
      if (fs.existsSync(copilotConfig)) {
        // Copilot CLI writes a `// banner` at the top of config.json,
        // so we must use a JSONC-tolerant parser. Bare `JSON.parse` was
        // throwing → catch swallowed → status falsely showed `❌ not
        // configured` even when copilot was logged in. (PR #46 fix,
        // 2026-05-12.)
        const cc = parseJsonc<any>(fs.readFileSync(copilotConfig, 'utf-8'));
        // Schema compat: snake_case (older CLI) + camelCase (newer CLI,
        // confirmed on rpi5 2026-04-24). Both shapes coexist in the wild
        // depending on which copilot CLI version provisioned the file.
        const loggedIn = cc.loggedInUsers ?? cc.logged_in_users;
        const lastUser = cc.lastLoggedInUser ?? cc.last_logged_in_user;
        const tokenBag = cc.copilotTokens ?? cc.copilot_tokens;
        const userPresent = (Array.isArray(loggedIn) && loggedIn.length > 0) || !!lastUser;
        const tokenPresent = tokenBag && typeof tokenBag === 'object' && Object.keys(tokenBag).length > 0;
        if (userPresent || tokenPresent) {
          hasAuth = true;
          const user = lastUser?.login || (Array.isArray(loggedIn) && loggedIn[0]?.login) || '';
          authLabel = `${provider} (CLI: ${user})`;
        }
      }
    } catch {
      /* ignore */
    }
    if (!hasAuth) {
      hasAuth = isCopilotAuthenticated();
      if (hasAuth) authLabel = provider;
    }
  }

  // Channels
  const channels: string[] = [];
  if (cfg.channels?.telegram?.enabled) channels.push('telegram');
  if (cfg.channels?.teams?.enabled) channels.push('teams');
  if (cfg.channels?.discord?.enabled) channels.push('discord');

  // Chat count — same semantics as `nanoclaw chat list` and doctor.
  let chatCount = 0;
  try {
    // listChats → getAllRegisteredGroups → v2 facade. The v2 DB must be
    // initialized before that read. Status is invoked as a one-shot CLI
    // process that does not run the daemon's full boot, so initialize
    // here (idempotent: initAndReconcileV2 is re-entrant).
    const { initAndReconcileV2 } = await import('../db/v2-boot.js');
    initAndReconcileV2();
    const { listChats } = await import('../chat-manager.js');
    chatCount = listChats().length;
  } catch {
    chatCount = 0;
  }

  // DevTunnel
  const dtPidFile = join(ws, 'devtunnel.pid');
  let tunnelRunning = false;
  if (existsSync(dtPidFile)) {
    try {
      process.kill(parseInt(fs.readFileSync(dtPidFile, 'utf-8').trim()), 0);
      tunnelRunning = true;
    } catch {
      /* dead */
    }
  }

  let version = 'unknown';
  try {
    const pkg = JSON.parse(fs.readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    version = pkg.version ?? 'unknown';
  } catch {
    /* ignore */
  }

  // Append short git commit from build-info.ts (generated by
  // scripts/write-build-info.mjs as a `prebuild` hook). Falls back silently
  // when the file isn't present (e.g. tsx dev-mode imports a stale tree)
  // or when build-time git lookup hit the 'dev' branch.
  let commit = 'dev';
  try {
    const bi = await import('../build-info.js');
    commit = (bi as any).COMMIT || 'dev';
  } catch {
    /* ignore */
  }
  if (commit && commit !== 'dev') {
    version = `${version} (${commit})`;
  } else if (commit === 'dev') {
    version = `${version} (dev)`;
  }

  return {
    version,
    running,
    pid,
    uptimeStr,
    model,
    thinkLevel,
    showThinking,
    mode,
    agentName,
    provider,
    hasAuth,
    authLabel,
    channels,
    chatCount,
    tunnelRunning,
    workspace: ws,
    logDir,
    chatJid,
    hasSessionOverride: overrideFields.length > 0,
    sessionOverrideFields: overrideFields,
  };
}

/**
 * Format a StatusInfo as the multi-line text shown by `nanoclaw status`.
 *
 * Plain text (no markdown). Channel adapters that prefer code-fence
 * formatting can wrap this themselves.
 */
export function formatStatusText(s: StatusInfo): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`🤖 NanoClaw ${s.version}`);
  lines.push(`🛠️ Mode:      ${s.mode}`);
  lines.push(
    `${s.running ? '✅' : '❌'} Status:    ${
      s.running ? `running (pid: ${s.pid}, uptime: ${s.uptimeStr})` : 'not running'
    }`,
  );
  lines.push(
    `🧠 Model:     ${s.model}${s.thinkLevel ? ` (think: ${s.thinkLevel})` : ''}${
      s.showThinking === 'flash'
        ? ' [reasoning flash]'
        : s.showThinking === true || s.showThinking === 'on'
          ? ' [reasoning visible]'
          : ''
    }`,
  );
  if (s.hasSessionOverride) {
    lines.push(`🎯 Scope:     this chat (override: ${s.sessionOverrideFields!.join(', ')})`);
  } else if (s.chatJid) {
    lines.push(`🎯 Scope:     this chat (using global default)`);
  }
  lines.push(`👤 Agent:     ${s.agentName} (${s.provider})`);
  lines.push(`🔑 Auth:      ${s.hasAuth ? `✅ ${s.authLabel}` : '❌ not configured'}`);
  lines.push(`📡 Channels:  ${s.channels.length > 0 ? s.channels.join(', ') : 'none'}`);
  lines.push(`💬 Chats:     ${s.chatCount} registered`);
  if (s.tunnelRunning) {
    lines.push(`🌐 Tunnel:    running`);
  }
  lines.push(`📁 Workspace: ${s.workspace}`);
  lines.push(`📝 Logs:      ${s.logDir}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * Convenience: collect + format. Used by both the CLI and the slash-command
 * handler. Returns a single string suitable for `console.log()` or
 * `channel.sendMessage()`.
 */
export async function getStatusText(chatJid?: string): Promise<string> {
  const info = await collectStatus(chatJid);
  return formatStatusText(info);
}
