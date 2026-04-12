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
    args: 'on|off',
    choices: [
      { title: 'On — show reasoning', value: 'on' },
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

  // /reasoning [on|off] — show/hide thinking output in messages
  const reasoningMatch = input.match(/^\/reasoning(?:\s+(on|off))?$/);
  if (reasoningMatch) {
    const mode = reasoningMatch[1] as 'on' | 'off' | undefined;
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

  // /tasks, /status, /capabilities, /wiki — pass to agent as prompts
  // These are handled by the agent using its tools/skills, not by nanoclaw directly.
  // Returning handled: false lets them flow through to the agent.
  if (input === '/tasks' || input === '/status' || input === '/capabilities') {
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
  mode: 'on' | 'off' | undefined,
  ctx: SlashCommandContext,
): Promise<void> {
  const { loadConfig, saveConfig } = await import('./config-loader.js');
  const config = loadConfig();

  if (!mode) {
    // Show current state
    const current = config.agents?.defaults?.showThinking ? 'on' : 'off';
    if (ctx.channel) {
      if (ctx.channel.sendCard) {
        const cmd = COMMANDS.find((c) => c.name === 'reasoning')!;
        const card = ctx.chatJid.startsWith('teams:')
          ? buildTeamsAdaptiveCard(cmd, current)
          : { command: 'reasoning', choices: cmd.choices };
        await ctx.channel.sendCard(
          ctx.chatJid,
          card,
          `🧠 Reasoning display: **${current}**\nUsage: /reasoning on|off`,
        );
      } else {
        await ctx.channel.sendMessage(
          ctx.chatJid,
          `🧠 Reasoning display: **${current}**\nUsage: /reasoning on|off`,
        );
      }
    }
    return;
  }

  if (!config.agents) config.agents = {} as any;
  if (!config.agents.defaults) config.agents.defaults = {} as any;
  config.agents.defaults.showThinking = mode === 'on';
  saveConfig(config);
  reloadConfig();
  if (ctx.channel) {
    await ctx.channel.sendMessage(
      ctx.chatJid,
      mode === 'on'
        ? '🧠 Reasoning is now **visible** in messages. Use `/reasoning off` to hide.'
        : '🧠 Reasoning is now **hidden**. Use `/reasoning on` to show.',
    );
  }
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
    saveConfig(config);
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
