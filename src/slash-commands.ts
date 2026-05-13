/**
 * Unified slash command registry + execution.
 *
 * Commands are defined once here. Each channel adapter reads COMMANDS for
 * native menus (Telegram setMyCommands, Teams Adaptive Card, etc.).
 *
 * handleSlashCommand() is the single entry point for command execution.
 * index.ts calls it and acts on the result — no command logic leaks into index.ts.
 *
 * NON-INVASIVE: no upstream channel files are modified.
 */

import fs from 'fs';
import path from 'path';
import { DATA_DIR, getConfig, reloadConfig } from './config.js';
import { deleteSession, getSessionOverrides, setSessionOverride } from './db.js';
import {
  getEffectiveThinkLevel,
  getEffectiveModel,
  getEffectiveShowThinking,
  providerForChat,
  type ThinkLevel,
  type ShowThinking,
} from './session-overrides.js';
import { Channel } from './types-extensions.js';

// ─── Command definitions ─────────────────────────────────────────────────────

export interface SlashCommand {
  /** Command name without leading / */
  name: string;
  /** Short description for menus */
  description: string;
  /** Argument placeholder (shown in help) */
  args?: string;
  /** Valid choices for the argument (used by Adaptive Card dropdowns) */
  choices?: { title: string; value: string }[];
  /** If true, command takes no arguments and executes immediately */
  noArgs?: boolean;
}

export const COMMANDS: SlashCommand[] = [
  {
    name: 'think',
    description: 'Set reasoning effort level',
    args: 'off|low|medium|high|xhigh',
    choices: [
      { title: 'Off (default)', value: 'off' },
      { title: 'Low', value: 'low' },
      { title: 'Medium', value: 'medium' },
      { title: 'High', value: 'high' },
      { title: 'Extra High', value: 'xhigh' },
    ],
  },
  {
    name: 'reasoning',
    description: 'Show or hide reasoning/thinking in messages',
    args: 'on|off|flash',
    choices: [
      { title: 'On — show reasoning (kept after final)', value: 'on' },
      { title: 'Flash — stream then replace with final', value: 'flash' },
      { title: 'Off — hide reasoning (default)', value: 'off' },
    ],
  },
  {
    name: 'new',
    description: 'Reset session — start fresh conversation',
    noArgs: true,
  },
  {
    name: 'tasks',
    description: 'List scheduled tasks',
    noArgs: true,
  },
  {
    name: 'status',
    description: 'Show agent status and config',
    noArgs: true,
  },
  {
    name: 'capabilities',
    description: 'Show available tools and skills',
    noArgs: true,
  },
  {
    name: 'help',
    description: 'Show available commands',
    noArgs: true,
  },
  {
    name: 'wiki',
    description: 'Knowledge base — ingest, query, or maintain your wiki',
    args: '[topic|search <query>]',
  },
  {
    name: 'model',
    description: 'Show or set active model (validates against provider catalog)',
    args: '[<model-id>]',
  },
  {
    name: 'models',
    description: 'List models available from the active provider',
    noArgs: true,
  },
  {
    name: 'plugin',
    description:
      'Manage plugins: list/install/remove/info/marketplace/reload (parity with `nanoclaw plugin` CLI; CC `/plugin` slash + GHC `nanoclaw plugin` shape)',
    args: '[list|install|remove|info|marketplace|reload] [args]',
  },
  {
    name: 'mcp',
    description:
      'List configured MCP servers (parity with CC `/mcp` and `gh copilot mcp list`). File-only read, <50ms.',
    args: '',
  },
];

// ─── Command execution ───────────────────────────────────────────────────────

/** Result of handling a slash command */
export interface SlashCommandResult {
  /** true if input was a recognized slash command */
  handled: boolean;
}

/**
 * Normalize raw message text into a slash command string.
 * Strips @mentions, lowercases, trims.
 */
export function normalizeSlashInput(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/^@\S+\s*/, '') // strip leading @mention
    .replace(/@\S+$/, ''); // strip trailing @botname (Telegram adds @bot_username)
}

/**
 * Context passed from index.ts — keeps slash-commands decoupled from index internals.
 */
export interface SlashCommandContext {
  chatJid: string;
  groupFolder: string;
  channel: Channel | undefined;
  /** Delete in-memory session entry (e.g., `delete sessions[folder]`) */
  clearSession: (folder: string) => void;
  /**
   * Forcibly terminate the active runner subprocess for this chat so the
   * next message respawns with a fresh env (picks up any session-level
   * slash override changes like /think, /model). Returns true if a runner
   * was killed. Optional — callers without queue access can pass undefined.
   */
  killActiveRunner?: (chatJid: string) => boolean;
}

/**
 * Handle a slash command if the input matches one.
 * Returns { handled: true } if it was a command, { handled: false } otherwise.
 *
 * Side effects: sends messages via channel, modifies config, deletes sessions.
 */
export async function handleSlashCommand(input: string, ctx: SlashCommandContext): Promise<SlashCommandResult> {
  // /new or /reset — clear session
  if (input === '/new' || input === '/reset') {
    ctx.clearSession(ctx.groupFolder);
    deleteSession(ctx.groupFolder);

    // Also clear .copilot session data
    const sessionDir = path.join(DATA_DIR, 'sessions', ctx.groupFolder, '.copilot');
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    if (ctx.channel) {
      await ctx.channel.sendMessage(ctx.chatJid, '🔄 Session reset. Next message starts a fresh conversation.');
    }
    return { handled: true };
  }

  // /think [level] [--default] — set reasoning effort.
  // Default scope is per-session (writes to sessions table). Pass
  // --default to write the global agent default in nanoclaw.json instead.
  // OpenClaw-style semantics, see PR #26 (2026-04-24).
  const thinkMatch = input.match(/^\/think(?:\s+(off|low|medium|high|xhigh))?(\s+--default)?$/);
  if (thinkMatch) {
    const level = thinkMatch[1] as string | undefined;
    const isDefault = !!thinkMatch[2];
    await handleThink(level, ctx, { isDefault });
    return { handled: true };
  }

  // /reasoning [on|off|flash] [--default] — show/hide/flash thinking
  // output. Per-session by default; --default writes global config.
  const reasoningMatch = input.match(/^\/reasoning(?:\s+(on|off|flash))?(\s+--default)?$/);
  if (reasoningMatch) {
    const mode = reasoningMatch[1] as 'on' | 'off' | 'flash' | undefined;
    const isDefault = !!reasoningMatch[2];
    await handleReasoning(mode, ctx, { isDefault });
    return { handled: true };
  }

  // /help — show available commands
  if (input === '/help') {
    if (ctx.channel) {
      await ctx.channel.sendMessage(ctx.chatJid, buildHelpText());
    }
    return { handled: true };
  }

  // /status — render `nanoclaw status` directly to chat (file-only read,
  // no LLM round-trip). Previously this was passed to the agent which made
  // it ~5-10s per invocation; now it returns in <50ms.
  if (input === '/status') {
    if (ctx.channel) {
      try {
        const { getStatusText } = await import('./cli/status-text.js');
        const text = await getStatusText(ctx.chatJid);
        // Wrap in a code fence so emoji-aligned columns render correctly
        // on Telegram/Teams/Discord (their default proportional fonts
        // would otherwise scramble the column alignment).
        await ctx.channel.sendMessage(ctx.chatJid, '```\n' + text.trim() + '\n```');
      } catch (err: any) {
        await ctx.channel.sendMessage(ctx.chatJid, `Failed to read status: ${err?.message ?? err}`);
      }
    }
    return { handled: true };
  }

  // /models — list available models from provider catalog (file-only/SDK call,
  // no LLM round-trip).
  if (input === '/models') {
    if (ctx.channel) {
      try {
        const text = await buildModelsListText(ctx.chatJid);
        await ctx.channel.sendMessage(ctx.chatJid, '```\n' + text.trim() + '\n```');
      } catch (err: any) {
        await ctx.channel.sendMessage(ctx.chatJid, `Failed to list models: ${err?.message ?? err}`);
      }
    }
    return { handled: true };
  }

  // /model [id] [--default] — show or set active model. Per-session by
  // default; --default writes the global agent config. Validates against
  // provider catalog (cached 5min) and refuses invalid IDs with a suggestion.
  const modelMatch = input.match(/^\/model(?:\s+(.+?))?(?:\s+--default)?$/);
  if (modelMatch) {
    const arg = modelMatch[1]?.trim();
    const isDefault = / --default(\s|$)/.test(input);
    await handleModel(arg, ctx, { isDefault });
    return { handled: true };
  }

  // /mcp — list configured MCP servers (file-only; <50ms). Mirrors CC
  // `/mcp` and `gh copilot mcp list` output so users get a familiar view
  // across surfaces. v2-only feature (kenan 2026-05-02): v1 frozen.
  if (input === '/mcp' || input.startsWith('/mcp ')) {
    if (ctx.channel) {
      try {
        const { getMcpText } = await import('./cli/mcp-text.js');
        // Teams renders box-drawing chars (`─`) as `?` inside code blocks;
        // force ASCII fallback there. Telegram/Discord/CLI keep Unicode.
        const ascii = ctx.channel.name === 'teams';
        const text = await getMcpText({ codeFence: true, ascii });
        await ctx.channel.sendMessage(ctx.chatJid, text);
      } catch (err: any) {
        await ctx.channel.sendMessage(ctx.chatJid, `Failed to list MCP servers: ${err?.message ?? err}`);
      }
    }
    return { handled: true };
  }

  // /tasks — render scheduled task list directly from DB (no LLM round-trip).
  // Previously this was passed to the agent which made it ~5-15s per
  // invocation (full agent turn + container spin + MCP `list_tasks` call).
  // Now it returns in <100ms — same short-circuit pattern as `/status`
  // (slash-commands.ts:214) and `/models`/`/mcp`. The agent path remains
  // available via natural-language requests like "show my tasks".
  // (kenan request 2026-05-12, PR #48.)
  if (input === '/tasks') {
    if (ctx.channel) {
      try {
        const [{ getAllTasks, getRegisteredGroup }, { formatTasksText }] = await Promise.all([
          import('./db.js'),
          import('./cli/task-format.js'),
        ]);
        // Parity with the prior MCP `list_tasks` (container/.../mcp-tools/scheduling.ts:174):
        //   * Filter by `group_folder` (NOT `chat_jid`) so isMain DMs that
        //     collapse onto a shared session see all of their sibling DM
        //     tasks (db.ts:51-86 collapse-on-read).
        //   * Main chat sees ALL groups' tasks (operator view).
        const isMain = !!getRegisteredGroup(ctx.chatJid)?.isMain;
        const all = getAllTasks();
        const rows = (isMain ? all : all.filter((t) => t.group_folder === ctx.groupFolder)).slice().sort((a, b) => {
          if (a.status !== b.status) return a.status < b.status ? -1 : 1;
          const an = a.next_run ? new Date(a.next_run).getTime() : Infinity;
          const bn = b.next_run ? new Date(b.next_run).getTime() : Infinity;
          return an - bn;
        });
        const text = formatTasksText(rows, {
          // Compact for non-main (chat-scoped); verbose for main (multi-group view).
          compact: !isMain,
          filterDesc: isMain ? 'all groups' : `group=${ctx.groupFolder}`,
        });
        await ctx.channel.sendMessage(ctx.chatJid, '```\n' + text.trim() + '\n```');
      } catch (err: any) {
        await ctx.channel.sendMessage(ctx.chatJid, `Failed to list tasks: ${err?.message ?? err}`);
      }
    }
    return { handled: true };
  }

  // /capabilities, /wiki — pass to agent as prompts
  // These are handled by the agent using its tools/skills, not by nanoclaw directly.
  // Returning handled: false lets them flow through to the agent.
  if (input === '/capabilities') {
    return { handled: false };
  }

  // /plugin [sub] [args] — manage plugins from chat. Mirrors the existing
  // `nanoclaw plugin <sub>` CLI exactly (delegates to runPluginCommand);
  // captures stdout/stderr and ships back as a code-fenced reply so the
  // user gets identical output to the CLI without leaving the chat.
  //
  // Compatibility intent (kenan 2026-04-25):
  //   * CC's `/plugin` interactive UI exposes list/install/uninstall/info +
  //     marketplace browse/add. We expose the SAME set, plus `reload`.
  //   * GHC's CLI is `gh copilot plugin <sub>`; nanoclaw already ships the
  //     `nanoclaw plugin <sub>` CLI. The slash command is a thin chat
  //     surface over that CLI — no behaviour drift.
  //   * `reload`: re-read nanoclaw.json + run ensureEnabledPluginsInstalled
  //     + kill the active runner so the next message respawns with the
  //     refreshed plugin set / MCP server list. Closest to CC's hot-reload
  //     semantics without requiring per-channel runtime injection.
  if (input === '/plugin' || input.startsWith('/plugin ')) {
    const argv = input.slice('/plugin'.length).trim().split(/\s+/).filter(Boolean);
    await handlePluginSlash(argv, ctx);
    return { handled: true };
  }

  // /wiki [topic|search <query>] — pass to agent with wiki skill context
  if (input === '/wiki' || input.startsWith('/wiki ')) {
    // Ensure wiki directory exists
    const wikiDir = path.join(DATA_DIR, 'sessions', ctx.groupFolder, 'wiki');
    if (!fs.existsSync(wikiDir)) {
      fs.mkdirSync(path.join(wikiDir, 'wiki', 'entities'), { recursive: true });
      fs.mkdirSync(path.join(wikiDir, 'wiki', 'concepts'), { recursive: true });
      fs.mkdirSync(path.join(wikiDir, 'sources'), { recursive: true });
      // Create initial index.md
      fs.writeFileSync(
        path.join(wikiDir, 'wiki', 'index.md'),
        '# Wiki Index\n\n_No pages yet. Send a link, file, or topic to get started._\n',
      );
      // Create initial log.md
      fs.writeFileSync(
        path.join(wikiDir, 'wiki', 'log.md'),
        `# Wiki Log\n\n## [${new Date().toISOString().split('T')[0]}] init\nWiki initialized.\n`,
      );
    }
    // Pass through to agent — the wiki skill handles the rest
    return { handled: false };
  }

  return { handled: false };
}

// ─── /plugin implementation ───────────────────────────────────────────

/**
 * Run a function while capturing whatever it writes to console.log /
 * console.error / process.stdout / process.stderr. Used by /plugin to
 * reuse the existing CLI handler (which prints to stdout) without
 * splitting its formatting logic.
 *
 * Restores the original handles in a finally so a thrown error inside
 * fn() can't permanently silence logs. Synchronous capture only — the
 * captured fn must await all its own work before returning.
 */
async function captureStdout(fn: () => Promise<void> | void): Promise<string> {
  const chunks: string[] = [];
  const origLog = console.log;
  const origError = console.error;
  const origWarn = console.warn;
  const push = (...args: unknown[]) => {
    chunks.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  console.log = (...args: unknown[]) => push(...args);
  console.error = (...args: unknown[]) => push(...args);
  console.warn = (...args: unknown[]) => push(...args);
  try {
    await fn();
  } finally {
    console.log = origLog;
    console.error = origError;
    console.warn = origWarn;
  }
  return chunks.join('\n');
}

async function handlePluginSlash(argv: string[], ctx: SlashCommandContext): Promise<void> {
  if (!ctx.channel) return;
  const sub = (argv[0] ?? 'list').toLowerCase();

  // /plugin reload — nanoclaw-specific (no CLI equivalent yet). Re-reads
  // nanoclaw.json, ensures enabled plugins are installed, and kills the
  // active runner so the next message respawns with the refreshed plugin
  // set. Closest analogue to CC's hot-reload (CC reloads MCP servers
  // when a plugin is added; nanoclaw spawns MCP servers at runner start,
  // so killing the runner is the only safe path).
  if (sub === 'reload') {
    try {
      reloadConfig();
      const { ensureEnabledPluginsInstalled } = await import('./cli/plugin.js');
      const result = await ensureEnabledPluginsInstalled();
      let killed = false;
      if (ctx.killActiveRunner) {
        killed = ctx.killActiveRunner(ctx.chatJid);
      }
      const lines: string[] = ['🔄 Plugin reload:'];
      if (result.installed.length) lines.push(`  installed: ${result.installed.join(', ')}`);
      if (result.skipped.length) lines.push(`  already-installed: ${result.skipped.join(', ')}`);
      if (result.failed.length) {
        for (const f of result.failed) {
          lines.push(`  ❌ ${f.name}: ${f.error}`);
        }
      }
      if (!result.installed.length && !result.skipped.length && !result.failed.length) {
        lines.push('  (no enabled plugins in nanoclaw.json)');
      }
      lines.push(
        killed
          ? '🔌 Active runner killed — next message respawns with refreshed plugins.'
          : 'ℹ️  No active runner; next message will pick up new plugin set.',
      );
      await ctx.channel.sendMessage(ctx.chatJid, lines.join('\n'));
    } catch (err: any) {
      await ctx.channel.sendMessage(ctx.chatJid, `❌ Plugin reload failed: ${err?.message ?? err}`);
    }
    return;
  }

  // All other subcommands delegate verbatim to the existing CLI handler
  // so behavior stays identical to `nanoclaw plugin <sub>`.
  try {
    const { runPluginCommand } = await import('./cli/plugin.js');
    const out = await captureStdout(() => runPluginCommand(argv));
    const trimmed = out.trim();
    const body = trimmed || '(no output)';
    // Code-fenced so emoji/columns/usage hints render verbatim across
    // Telegram/Teams/Discord proportional fonts.
    await ctx.channel.sendMessage(ctx.chatJid, '```\n' + body + '\n```');
  } catch (err: any) {
    await ctx.channel.sendMessage(ctx.chatJid, `❌ /plugin ${sub} failed: ${err?.message ?? err}`);
  }
}

// ─── /reasoning implementation ───────────────────────────────────────────────

async function handleReasoning(
  mode: ShowThinking | undefined,
  ctx: SlashCommandContext,
  opts: { isDefault: boolean } = { isDefault: false },
): Promise<void> {
  const provider = providerForChat(ctx.chatJid);

  if (!mode) {
    const effective = getEffectiveShowThinking(ctx.chatJid) ?? 'off';
    const overrides = getSessionOverrides(ctx.groupFolder, provider);
    const scopeLabel = overrides.showThinking ? '(session override)' : '(global default)';
    if (ctx.channel) {
      const usage =
        '\nUsage: /reasoning on|off|flash [--default]\n' +
        '`--default` writes nanoclaw.json (all chats); omit it to set just this chat.';
      if (ctx.channel.sendCard) {
        const cmd = COMMANDS.find((c) => c.name === 'reasoning')!;
        const card = ctx.chatJid.startsWith('teams:')
          ? buildTeamsAdaptiveCard(cmd, effective)
          : { command: 'reasoning', choices: cmd.choices };
        await ctx.channel.sendCard(ctx.chatJid, card, `🧠 Reasoning display: **${effective}** ${scopeLabel}${usage}`);
      } else {
        await ctx.channel.sendMessage(ctx.chatJid, `🧠 Reasoning display: **${effective}** ${scopeLabel}${usage}`);
      }
    }
    return;
  }

  if (opts.isDefault) {
    const { loadConfig, saveConfig } = await import('./config-loader.js');
    const config = loadConfig();
    if (!config.agents) config.agents = {} as any;
    if (!config.agents.defaults) config.agents.defaults = {} as any;
    config.agents.defaults.showThinking = mode;
    saveConfig(config, 'slash-command', {
      command: '/reasoning --default',
      mode,
      chatJid: ctx.chatJid,
    });
    reloadConfig();
    if (ctx.channel) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 **Global default** reasoning display set to **${mode}**. Affects all chats.`,
      );
    }
    return;
  }

  // Per-session: no runner respawn needed. Reasoning display is read at
  // dispatcher time via getEffectiveShowThinking, so the change takes
  // effect on the next message immediately.
  setSessionOverride(ctx.groupFolder, 'show_thinking', mode, provider);
  if (ctx.channel) {
    const blurb =
      mode === 'on'
        ? '🧠 Reasoning is now **visible** for this chat.'
        : mode === 'flash'
          ? '🧠 Reasoning set to **flash** for this chat — streamed live, replaced by final answer.'
          : '🧠 Reasoning is now **hidden** for this chat.';
    await ctx.channel.sendMessage(ctx.chatJid, `${blurb} Use \`/reasoning ${mode} --default\` to apply globally.`);
  }
}

// ─── /model + /models implementation ────────────────────────────────────────

interface ModelEntry {
  id: string;
  name?: string;
  premium: boolean;
  enabled: boolean;
  family?: string;
  reasoningEfforts?: string[];
}
const modelCatalogCache: Map<string, { ts: number; models: ModelEntry[] }> = new Map();
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch the provider's model catalog. Currently only github-copilot via SDK
 * is supported; other providers fall back to an empty list (no validation).
 */
async function getModelCatalog(provider: string): Promise<ModelEntry[]> {
  const now = Date.now();
  const cached = modelCatalogCache.get(provider);
  if (cached && now - cached.ts < MODEL_CATALOG_TTL_MS) {
    return cached.models;
  }
  if (provider !== 'github-copilot') {
    modelCatalogCache.set(provider, { ts: now, models: [] });
    return [];
  }
  let sdk: any;
  try {
    sdk = await import('@github/copilot-sdk');
  } catch (err: any) {
    throw new Error(`@github/copilot-sdk not installed: ${err?.message ?? err}`);
  }
  const client = new sdk.CopilotClient();
  await client.start();
  let raw: any;
  try {
    raw = await client.listModels();
  } finally {
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
  }
  const list = Array.isArray(raw) ? raw : raw?.models || raw?.data || [];
  const models: ModelEntry[] = list.map((m: any) => ({
    id: String(m.id ?? m.model ?? ''),
    name: m.name,
    premium: !!m.billing?.is_premium,
    enabled: m.policy?.state !== 'disabled',
    family: m.capabilities?.family,
    reasoningEfforts: m.supportedReasoningEfforts,
  }));
  modelCatalogCache.set(provider, { ts: now, models });
  return models;
}

function stripProviderPrefix(id: string): string {
  const slash = id.indexOf('/');
  return slash > 0 ? id.substring(slash + 1) : id;
}

function suggestClosestModel(candidate: string, models: ModelEntry[]): string | undefined {
  const lower = candidate.toLowerCase();
  const exact = models.find((m) => m.id === candidate);
  if (exact) return exact.id;
  const ci = models.find((m) => m.id.toLowerCase() === lower);
  if (ci) return ci.id;
  const prefix = models.find((m) => m.id.toLowerCase().startsWith(lower));
  if (prefix) return prefix.id;
  // Try same family ("claude-opus-4.7" → "claude-opus-4.6")
  const familyPrefix = lower.split(/[-.]/).slice(0, 2).join('-');
  if (familyPrefix) {
    const fam = models
      .filter((m) => m.id.toLowerCase().startsWith(familyPrefix))
      .sort((a, b) => b.id.localeCompare(a.id))[0];
    if (fam) return fam.id;
  }
  return undefined;
}

export async function buildModelsListText(chatJid?: string): Promise<string> {
  const config = getConfig();
  const provider = config.agents?.defaults?.provider || 'github-copilot';
  // Show the *effective* model for this chat (respects /model session
  // overrides) so /models, /model (no-arg), and /status all agree. Falls
  // back to the global default when no chatJid (e.g. CLI/testing).
  // Without this, a chat with `/model gpt-5.5` override sees /models'
  // ▸ marker pointing at the global default while /status reports gpt-5.5.
  // Reported by kenan 2026-04-27 (Teams chat with override).
  const currentModel =
    (chatJid ? getEffectiveModel(chatJid) : undefined) || config.agents?.defaults?.model || '(unset)';
  let models: ModelEntry[];
  try {
    models = await getModelCatalog(provider);
  } catch (err: any) {
    return `Provider: ${provider}\nCurrent model: ${currentModel}\n\nFailed to fetch catalog: ${err?.message ?? err}`;
  }
  const lines: string[] = [`Provider: ${provider}`, `Current model: ${currentModel}`, ''];
  if (models.length === 0) {
    lines.push(`No catalog available for provider "${provider}". /model <id> still accepts any value (no validation).`);
    return lines.join('\n');
  }
  const sorted = [...models].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  const idWidth = Math.max(...sorted.map((m) => m.id.length), 6);
  lines.push(`${'MODEL'.padEnd(idWidth)}  TIER     STATE`);
  for (const m of sorted) {
    const marker = m.id === currentModel ? '▸ ' : '  ';
    const tier = m.premium ? 'premium' : 'free   ';
    const state = m.enabled ? 'enabled ' : 'disabled';
    lines.push(`${marker}${m.id.padEnd(idWidth)}  ${tier}  ${state}`);
  }
  lines.push('');
  lines.push(`Use /model <id> to switch (e.g. /model ${sorted[0]?.id}).`);
  return lines.join('\n');
}

async function handleModel(
  arg: string | undefined,
  ctx: SlashCommandContext,
  opts: { isDefault: boolean } = { isDefault: false },
): Promise<void> {
  const config = getConfig();
  const provider = config.agents?.defaults?.provider || 'github-copilot';
  const sessionProvider = providerForChat(ctx.chatJid);

  if (!arg) {
    if (!ctx.channel) return;
    const effective = getEffectiveModel(ctx.chatJid) || '(unset)';
    const overrides = getSessionOverrides(ctx.groupFolder, sessionProvider);
    const scopeLabel = overrides.model ? '(session override)' : '(global default)';
    let topModels: ModelEntry[] = [];
    try {
      const catalog = await getModelCatalog(provider);
      topModels = catalog.filter((m) => m.enabled).sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      // fall through to plain text
    }
    const usage =
      '\nUsage: /model <id> [--default] — see /models for the full list.\n' +
      '`--default` writes nanoclaw.json (all chats); omit it to set just this chat.';
    if (ctx.channel.sendCard && topModels.length > 0) {
      const choices = topModels.slice(0, 25).map((m) => ({
        title: `${m.name || m.id}${m.premium ? ' (premium)' : ''}`,
        value: m.id,
      }));
      const fakeCmd: SlashCommand = {
        name: 'model',
        description: 'Set active model',
        args: '<model-id>',
        choices,
      };
      const card = ctx.chatJid.startsWith('teams:')
        ? buildTeamsAdaptiveCard(fakeCmd, effective)
        : { command: 'model', choices };
      await ctx.channel.sendCard(ctx.chatJid, card, `🧠 Model: **${effective}** (${provider}) ${scopeLabel}${usage}`);
    } else {
      await ctx.channel.sendMessage(ctx.chatJid, `🧠 Model: **${effective}** (${provider}) ${scopeLabel}${usage}`);
    }
    return;
  }

  const requested = stripProviderPrefix(arg);
  let catalog: ModelEntry[] = [];
  try {
    catalog = await getModelCatalog(provider);
  } catch (err: any) {
    if (ctx.channel) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `⚠️ Could not validate against ${provider} catalog (${err?.message ?? err}). Setting anyway.`,
      );
    }
  }
  if (catalog.length > 0) {
    const match = catalog.find((m) => m.id === requested);
    if (!match) {
      const suggestion = suggestClosestModel(requested, catalog);
      if (ctx.channel) {
        const hint = suggestion
          ? `\nDid you mean **${suggestion}**? Run \`/model ${suggestion}\`.`
          : '\nRun /models to see what is available.';
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `❌ Model **${requested}** is not available from ${provider}.${hint}`,
        );
      }
      return;
    }
    if (!match.enabled) {
      if (ctx.channel) {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `⚠️ Model **${match.id}** is disabled by your provider's policy. Run /models to see enabled options.`,
        );
      }
      return;
    }
  }

  if (opts.isDefault) {
    const { loadConfig, saveConfig } = await import('./config-loader.js');
    const fresh = loadConfig();
    if (!fresh.agents) fresh.agents = {} as any;
    if (!fresh.agents.defaults) fresh.agents.defaults = {} as any;
    const previous = fresh.agents.defaults.model;
    fresh.agents.defaults.model = requested;
    const slashIdx = arg.indexOf('/');
    if (slashIdx > 0) {
      fresh.agents.defaults.provider = arg.substring(0, slashIdx);
    }
    saveConfig(fresh, 'slash-command', {
      command: '/model --default',
      previous,
      next: requested,
      chatJid: ctx.chatJid,
    });
    reloadConfig();
    if (ctx.channel) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 **Global default** model set to **${requested}** (${provider}). Affects all chats. Next message respawns runner.`,
      );
    }
  } else {
    setSessionOverride(ctx.groupFolder, 'model', requested, sessionProvider);
    const respawned = ctx.killActiveRunner?.(ctx.chatJid) ?? false;
    if (ctx.channel) {
      const note = respawned ? ' (current runner stopped — next message will use new model)' : '';
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 Model set to **${requested}** for this chat${note}. Use \`/model ${requested} --default\` to apply globally.`,
      );
    }
  }
}

/** Test-only: clear the catalog cache. */
export function _resetModelCatalogCache(): void {
  modelCatalogCache.clear();
}

// ─── /think implementation ───────────────────────────────────────────────────

async function handleThink(
  level: string | undefined,
  ctx: SlashCommandContext,
  opts: { isDefault: boolean } = { isDefault: false },
): Promise<void> {
  const provider = providerForChat(ctx.chatJid);
  if (!level) {
    // Show current effective level (session override > global default).
    const effective = getEffectiveThinkLevel(ctx.chatJid) ?? 'off';
    const overrides = getSessionOverrides(ctx.groupFolder, provider);
    const scopeLabel = overrides.thinkLevel ? '(session override)' : '(global default)';
    if (ctx.channel) {
      const usage =
        '\nUsage: /think off|low|medium|high|xhigh [--default]\n' +
        '`--default` writes nanoclaw.json (all chats); omit it to set just this chat.';
      if (ctx.channel.sendCard) {
        const thinkCmd = COMMANDS.find((c) => c.name === 'think')!;
        const card = ctx.chatJid.startsWith('teams:')
          ? buildTeamsAdaptiveCard(thinkCmd, effective)
          : { command: 'think', choices: thinkCmd.choices };
        await ctx.channel.sendCard(ctx.chatJid, card, `🧠 Think level: **${effective}** ${scopeLabel}${usage}`);
      } else {
        await ctx.channel.sendMessage(ctx.chatJid, `🧠 Think level: **${effective}** ${scopeLabel}${usage}`);
      }
    }
    return;
  }

  if (opts.isDefault) {
    // Global write: same as old behavior, persists across all chats.
    const { loadConfig, saveConfig } = await import('./config-loader.js');
    const config = loadConfig();
    if (level === 'off') {
      delete config.agents.defaults.thinkLevel;
    } else {
      config.agents.defaults.thinkLevel = level as 'low' | 'medium' | 'high' | 'xhigh';
    }
    saveConfig(config, 'slash-command', {
      command: '/think --default',
      level,
      chatJid: ctx.chatJid,
    });
    reloadConfig();
    if (ctx.channel) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 **Global default** think level set to **${level}**. Affects all chats. Takes effect on next message (after runner respawn).`,
      );
    }
  } else {
    // Per-session write: only this chat. Kill the active runner so the
    // next message respawns with the new env.
    setSessionOverride(ctx.groupFolder, 'think_level', level === 'off' ? null : level, provider);
    const respawned = ctx.killActiveRunner?.(ctx.chatJid) ?? false;
    if (ctx.channel) {
      const note = respawned ? ' (current runner stopped — next message will use new value)' : '';
      const detail = level === 'off' ? `cleared (will inherit global default)` : `**${level}**`;
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 Think level set to ${detail} for this chat${note}. Use \`/think ${level} --default\` to apply globally.`,
      );
    }
  }
}

// ─── Telegram: register bot menu commands ────────────────────────────────────

/**
 * Register commands with Telegram Bot API (setMyCommands).
 * Call once after bot connects. Non-invasive — uses HTTP API directly.
 */
export async function registerTelegramCommands(botToken: string): Promise<void> {
  const commands = COMMANDS.map((c) => ({
    command: c.name,
    description: c.description + (c.args ? ` (${c.args})` : ''),
  }));

  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ commands }),
    });
    const data = (await resp.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(`[slash-commands] Telegram setMyCommands failed: ${data.description}`);
    }
  } catch (err) {
    console.error(`[slash-commands] Telegram setMyCommands error: ${err}`);
  }
}

// ─── Teams: Adaptive Card for command selection ──────────────────────────────

/**
 * Build a Teams Adaptive Card JSON for a command with choices.
 * When user sends /think (no args), we reply with this card.
 */
export function buildTeamsAdaptiveCard(command: SlashCommand, currentValue?: string): object {
  if (!command.choices) {
    return {
      type: 'AdaptiveCard',
      $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
      version: '1.4',
      body: [
        {
          type: 'TextBlock',
          text: `/${command.name}: ${command.description}`,
          weight: 'bolder',
          size: 'medium',
        },
      ],
    };
  }

  return {
    type: 'AdaptiveCard',
    $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
    version: '1.4',
    body: [
      {
        type: 'TextBlock',
        text: command.description,
        weight: 'bolder',
        size: 'medium',
      },
      ...(currentValue
        ? [
            {
              type: 'TextBlock',
              text: `Current: **${currentValue}**`,
              spacing: 'small',
            },
          ]
        : []),
      {
        type: 'Input.ChoiceSet',
        id: `${command.name}_value`,
        label: `Select ${command.name} level:`,
        style: 'compact',
        value: currentValue || command.choices[0]?.value || '',
        choices: command.choices.map((c) => ({
          title: c.title,
          value: c.value,
        })),
      },
    ],
    actions: [
      {
        type: 'Action.Submit',
        title: 'Apply',
        data: { command: command.name },
      },
    ],
  };
}

/**
 * Parse a Teams Adaptive Card submit action.
 * Returns the slash command text (e.g., "/think high") or null if not a card submit.
 */
export function parseTeamsCardSubmit(activity: any): string | null {
  if (activity.type !== 'message') return null;

  // Adaptive Card submissions come as activity.value (no activity.text)
  const value = activity.value;
  if (!value || typeof value !== 'object') return null;

  const command = value.command;
  if (!command) return null;

  // Find the command definition
  const cmd = COMMANDS.find((c) => c.name === command);
  if (!cmd) return null;

  // Extract the selected value
  const selectedValue = value[`${command}_value`];
  if (selectedValue) {
    return `/${command} ${selectedValue}`;
  }

  return `/${command}`;
}

// ─── Help text generator ─────────────────────────────────────────────────────

export function buildHelpText(): string {
  const lines = ['**Available commands:**', ''];
  for (const cmd of COMMANDS) {
    const argStr = cmd.args ? ` <${cmd.args}>` : '';
    lines.push(`  \`/${cmd.name}${argStr}\` — ${cmd.description}`);
  }
  return lines.join('\n');
}
