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
import { deleteSession } from './db.js';
import { Channel } from './types.js';

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
    description:
      'Show or set active model (validates against provider catalog)',
    args: '[<model-id>]',
  },
  {
    name: 'models',
    description: 'List models available from the active provider',
    noArgs: true,
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
}

/**
 * Handle a slash command if the input matches one.
 * Returns { handled: true } if it was a command, { handled: false } otherwise.
 *
 * Side effects: sends messages via channel, modifies config, deletes sessions.
 */
export async function handleSlashCommand(
  input: string,
  ctx: SlashCommandContext,
): Promise<SlashCommandResult> {
  // /new or /reset — clear session
  if (input === '/new' || input === '/reset') {
    ctx.clearSession(ctx.groupFolder);
    deleteSession(ctx.groupFolder);

    // Also clear .copilot session data
    const sessionDir = path.join(
      DATA_DIR,
      'sessions',
      ctx.groupFolder,
      '.copilot',
    );
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }

    if (ctx.channel) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        '🔄 Session reset. Next message starts a fresh conversation.',
      );
    }
    return { handled: true };
  }

  // /think [level] — set reasoning effort
  const thinkMatch = input.match(
    /^\/think(?:\s+(off|low|medium|high|xhigh))?$/,
  );
  if (thinkMatch) {
    const level = thinkMatch[1] as string | undefined;
    await handleThink(level, ctx);
    return { handled: true };
  }

  // /reasoning [on|off|flash] — show/hide/flash thinking output in messages
  const reasoningMatch = input.match(/^\/reasoning(?:\s+(on|off|flash))?$/);
  if (reasoningMatch) {
    const mode = reasoningMatch[1] as 'on' | 'off' | 'flash' | undefined;
    await handleReasoning(mode, ctx);
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
        const text = await getStatusText();
        // Wrap in a code fence so emoji-aligned columns render correctly
        // on Telegram/Teams/Discord (their default proportional fonts
        // would otherwise scramble the column alignment).
        await ctx.channel.sendMessage(
          ctx.chatJid,
          '```\n' + text.trim() + '\n```',
        );
      } catch (err: any) {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `Failed to read status: ${err?.message ?? err}`,
        );
      }
    }
    return { handled: true };
  }

  // /models — list available models from provider catalog (file-only/SDK call,
  // no LLM round-trip).
  if (input === '/models') {
    if (ctx.channel) {
      try {
        const text = await buildModelsListText();
        await ctx.channel.sendMessage(
          ctx.chatJid,
          '```\n' + text.trim() + '\n```',
        );
      } catch (err: any) {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `Failed to list models: ${err?.message ?? err}`,
        );
      }
    }
    return { handled: true };
  }

  // /model [id] — show or set the active model. Validates against provider
  // catalog (cached 5min) and refuses invalid IDs with a suggestion.
  const modelMatch = input.match(/^\/model(?:\s+(.+))?$/);
  if (modelMatch) {
    const arg = modelMatch[1]?.trim();
    await handleModel(arg, ctx);
    return { handled: true };
  }

  // /tasks, /capabilities, /wiki — pass to agent as prompts
  // These are handled by the agent using its tools/skills, not by nanoclaw directly.
  // Returning handled: false lets them flow through to the agent.
  if (input === '/tasks' || input === '/capabilities') {
    return { handled: false };
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

// ─── /reasoning implementation ───────────────────────────────────────────────

async function handleReasoning(
  mode: 'on' | 'off' | 'flash' | undefined,
  ctx: SlashCommandContext,
): Promise<void> {
  const { loadConfig, saveConfig } = await import('./config-loader.js');
  const config = loadConfig();

  // Normalize current value: legacy boolean (true=on, false=off) +
  // new string enum ('on' | 'off' | 'flash').
  const raw = config.agents?.defaults?.showThinking;
  const current: 'on' | 'off' | 'flash' =
    raw === true ? 'on' : raw === 'flash' ? 'flash' : 'off';

  if (!mode) {
    if (ctx.channel) {
      if (ctx.channel.sendCard) {
        const cmd = COMMANDS.find((c) => c.name === 'reasoning')!;
        const card = ctx.chatJid.startsWith('teams:')
          ? buildTeamsAdaptiveCard(cmd, current)
          : { command: 'reasoning', choices: cmd.choices };
        await ctx.channel.sendCard(
          ctx.chatJid,
          card,
          `🧠 Reasoning display: **${current}**\nUsage: /reasoning on|off|flash`,
        );
      } else {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `🧠 Reasoning display: **${current}**\nUsage: /reasoning on|off|flash`,
        );
      }
    }
    return;
  }

  if (!config.agents) config.agents = {} as any;
  if (!config.agents.defaults) config.agents.defaults = {} as any;
  // Store as string enum (drop legacy boolean shape on write).
  config.agents.defaults.showThinking = mode;
  saveConfig(config, 'slash-command', {
    command: '/reasoning',
    mode,
    chatJid: ctx.chatJid,
  });
  reloadConfig();
  if (ctx.channel) {
    const blurb =
      mode === 'on'
        ? '🧠 Reasoning is now **visible** (kept after final answer). Use `/reasoning off` to hide or `/reasoning flash` for transient mode.'
        : mode === 'flash'
          ? '🧠 Reasoning set to **flash** — streamed live, replaced by the final answer. Use `/reasoning on` to keep it, or `/reasoning off` to hide.'
          : '🧠 Reasoning is now **hidden**. Use `/reasoning on` to show, or `/reasoning flash` for transient.';
    await ctx.channel.sendMessage(ctx.chatJid, blurb);
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
const modelCatalogCache: Map<string, { ts: number; models: ModelEntry[] }> =
  new Map();
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
    throw new Error(
      `@github/copilot-sdk not installed: ${err?.message ?? err}`,
    );
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

function suggestClosestModel(
  candidate: string,
  models: ModelEntry[],
): string | undefined {
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

export async function buildModelsListText(): Promise<string> {
  const config = getConfig();
  const provider = config.agents?.defaults?.provider || 'github-copilot';
  const currentModel = config.agents?.defaults?.model || '(unset)';
  let models: ModelEntry[];
  try {
    models = await getModelCatalog(provider);
  } catch (err: any) {
    return `Provider: ${provider}\nCurrent model: ${currentModel}\n\nFailed to fetch catalog: ${err?.message ?? err}`;
  }
  const lines: string[] = [
    `Provider: ${provider}`,
    `Current model: ${currentModel}`,
    '',
  ];
  if (models.length === 0) {
    lines.push(
      `No catalog available for provider "${provider}". /model <id> still accepts any value (no validation).`,
    );
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
): Promise<void> {
  const config = getConfig();
  const provider = config.agents?.defaults?.provider || 'github-copilot';
  const currentModel = config.agents?.defaults?.model || '(unset)';

  if (!arg) {
    if (!ctx.channel) return;
    let topModels: ModelEntry[] = [];
    try {
      const catalog = await getModelCatalog(provider);
      topModels = catalog
        .filter((m) => m.enabled)
        .sort((a, b) => a.id.localeCompare(b.id));
    } catch {
      // fall through to plain text
    }
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
        ? buildTeamsAdaptiveCard(fakeCmd, currentModel)
        : { command: 'model', choices };
      await ctx.channel.sendCard(
        ctx.chatJid,
        card,
        `🧠 Model: **${currentModel}** (${provider})\nUsage: /model <id> — see /models for the full list.`,
      );
    } else {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 Model: **${currentModel}** (${provider})\nUsage: /model <id> — see /models for the full list.`,
      );
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
    command: '/model',
    previous,
    next: requested,
    chatJid: ctx.chatJid,
  });
  reloadConfig();
  if (ctx.channel) {
    await ctx.channel.sendMessage(
      ctx.chatJid,
      `🧠 Model set to **${requested}** (${provider}). Takes effect on the next message.`,
    );
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
): Promise<void> {
  if (!level) {
    // Show current think level with interactive selection
    const currentLevel = getConfig().agents?.defaults?.thinkLevel || 'off';
    if (ctx.channel) {
      if (ctx.channel.sendCard) {
        const thinkCmd = COMMANDS.find((c) => c.name === 'think')!;
        // Teams: Adaptive Card; Telegram: inline keyboard via sendCard
        const card = ctx.chatJid.startsWith('teams:')
          ? buildTeamsAdaptiveCard(thinkCmd, currentLevel)
          : { command: 'think', choices: thinkCmd.choices };
        await ctx.channel.sendCard(
          ctx.chatJid,
          card,
          `🧠 Think level: **${currentLevel}**\nUsage: /think off|low|medium|high|xhigh`,
        );
      } else {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `🧠 Think level: **${currentLevel}**\nUsage: /think off|low|medium|high|xhigh`,
        );
      }
    }
  } else {
    // Update config in memory and persist to file
    const { loadConfig, saveConfig } = await import('./config-loader.js');
    const config = loadConfig();
    if (level === 'off') {
      delete config.agents.defaults.thinkLevel;
    } else {
      config.agents.defaults.thinkLevel = level as
        | 'low'
        | 'medium'
        | 'high'
        | 'xhigh';
    }
    saveConfig(config, 'slash-command', {
      command: '/think',
      level: level,
      chatJid: ctx.chatJid,
    });
    reloadConfig();
    if (ctx.channel) {
      await ctx.channel.sendMessage(
        ctx.chatJid,
        `🧠 Think level set to **${level}**. Takes effect on next message.`,
      );
    }
  }
}

// ─── Telegram: register bot menu commands ────────────────────────────────────

/**
 * Register commands with Telegram Bot API (setMyCommands).
 * Call once after bot connects. Non-invasive — uses HTTP API directly.
 */
export async function registerTelegramCommands(
  botToken: string,
): Promise<void> {
  const commands = COMMANDS.map((c) => ({
    command: c.name,
    description: c.description + (c.args ? ` (${c.args})` : ''),
  }));

  try {
    const resp = await fetch(
      `https://api.telegram.org/bot${botToken}/setMyCommands`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commands }),
      },
    );
    const data = (await resp.json()) as { ok: boolean; description?: string };
    if (!data.ok) {
      console.error(
        `[slash-commands] Telegram setMyCommands failed: ${data.description}`,
      );
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
export function buildTeamsAdaptiveCard(
  command: SlashCommand,
  currentValue?: string,
): object {
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
