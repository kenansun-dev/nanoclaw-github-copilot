/**
 * nanoclaw channel — manage channel configuration
 *
 * Usage:
 *   nanoclaw channel list                        — show configured channels
 *   nanoclaw channel add <name> [--agent <id>]   — configure a channel
 *   nanoclaw channel remove <name>               — disable a channel
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

import { loadConfig, saveConfig, resolveAgent } from '../config-loader.js';
import { resolveWorkspace } from '../workspace.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(__dirname, '..', '..');

const SUPPORTED_CHANNELS = ['telegram', 'teams'] as const;
type ChannelName = (typeof SUPPORTED_CHANNELS)[number];

interface ChannelField {
  key: string;
  prompt: string;
  required?: boolean;
  secret?: boolean;
}

const CHANNEL_FIELDS: Record<ChannelName, ChannelField[]> = {
  telegram: [
    {
      key: 'botToken',
      prompt: 'Bot token (from @BotFather)',
      required: true,
      secret: true,
    },
  ],
  teams: [
    {
      key: 'appId',
      prompt: 'App ID (Azure Bot registration)',
      required: true,
    },
    {
      key: 'appPassword',
      prompt: 'App Password (client secret)',
      required: false,
      secret: true,
    },
    {
      key: 'tenantId',
      prompt: 'Tenant ID (or "common" for multi-tenant)',
      required: false,
    },
  ],
};

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function runChannelCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || 'list';

  switch (subcommand) {
    case 'list':
      return channelList();
    case 'add':
      return channelAdd(args[1], args.slice(2));
    case 'remove':
      return channelRemove(args[1]);
    default:
      console.log(
        'Usage: nanoclaw channel <list|add|remove> [name] [--agent <id>] [--force]',
      );
      console.log('Channels: ' + SUPPORTED_CHANNELS.join(', '));
  }
}

// ---------------------------------------------------------------------------
// Parse flags from args
// ---------------------------------------------------------------------------

function parseFlags(args: string[]): { agent?: string; force: boolean } {
  let agent: string | undefined;
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      agent = args[++i];
    } else if (args[i] === '--force') {
      force = true;
    }
  }
  return { agent, force };
}

// ---------------------------------------------------------------------------
// channel list
// ---------------------------------------------------------------------------

function channelList(): void {
  const config = loadConfig();
  const channels = config.channels || {};

  console.log('\nConfigured channels:\n');

  for (const name of SUPPORTED_CHANNELS) {
    const ch = (channels as any)[name];
    if (!ch) {
      console.log(`  ${name}: not configured`);
      continue;
    }

    const enabled = ch.enabled ? '✅ enabled' : '❌ disabled';
    const fields = CHANNEL_FIELDS[name];
    const hasCredentials = fields
      .filter((f) => f.required)
      .every((f) => !!(ch as any)[f.key]);

    console.log(
      `  ${name}: ${enabled}${hasCredentials ? '' : ' (missing credentials)'}`,
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// channel add
// ---------------------------------------------------------------------------

async function channelAdd(
  name: string | undefined,
  args: string[],
): Promise<void> {
  if (!name) {
    console.log('Usage: nanoclaw channel add <name> [--agent <id>] [--force]');
    console.log('Available: ' + SUPPORTED_CHANNELS.join(', '));
    return;
  }

  if (!SUPPORTED_CHANNELS.includes(name as ChannelName)) {
    console.error(`Unknown channel: ${name}`);
    console.log('Available: ' + SUPPORTED_CHANNELS.join(', '));
    return;
  }

  const channelName = name as ChannelName;
  const flags = parseFlags(args);

  // Resolve agent
  const config = loadConfig();
  const agentId = flags.agent;
  if (agentId) {
    // Check agent exists
    const agentList = config.agents?.list || [];
    const found = agentList.find((a: any) => a.id === agentId);
    if (!found) {
      console.error(
        `Agent '${agentId}' not found in config. Add it to agents.list first.`,
      );
      return;
    }
  }

  // Check if agent already has this channel configured
  const agent = resolveAgent(config, agentId);
  const agentName = agent.name || agentId || 'default';
  const existingChannel = (config.channels as any)?.[channelName];
  if (existingChannel?.enabled && existingChannel?.appId && !flags.force) {
    console.log(`Agent '${agentName}' already has ${channelName} configured.`);
    console.log(
      `  Use --force to reconfigure, or --agent <name> for a different agent.`,
    );
    return;
  }

  // Teams: run setup-teams script
  if (channelName === 'teams') {
    return channelAddTeams(agentName, flags.force);
  }

  // Other channels: interactive credential input
  return channelAddInteractive(channelName);
}

// ---------------------------------------------------------------------------
// Interactive credential input (Telegram, etc.)
// ---------------------------------------------------------------------------

async function channelAddInteractive(channelName: ChannelName): Promise<void> {
  const fields = CHANNEL_FIELDS[channelName];

  if (!process.stdin.isTTY) {
    console.log('Interactive mode required. Run from a terminal.');
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log(`\nConfiguring ${channelName}:\n`);

  const config = loadConfig();
  config.channels = config.channels || {};
  const channelConfig: Record<string, any> =
    (config.channels as any)[channelName] || {};
  channelConfig.enabled = true;

  for (const field of fields) {
    const current = channelConfig[field.key];
    const currentHint = current
      ? field.secret
        ? ' (current: ***)'
        : ` (current: ${current})`
      : '';
    const requiredHint = field.required ? ' *' : '';

    const value = await ask(`  ${field.prompt}${requiredHint}${currentHint}: `);
    if (value.trim()) {
      if (field.key === 'webhookPort') {
        channelConfig[field.key] = parseInt(value.trim(), 10) || 3978;
      } else {
        channelConfig[field.key] = value.trim();
      }
    }
  }

  (config.channels as any)[channelName] = channelConfig;
  saveConfig(config);

  rl.close();

  console.log(`\n✅ ${channelName} configured and enabled in nanoclaw.json`);
  console.log('  Restart nanoclaw for changes to take effect.\n');
}

// ---------------------------------------------------------------------------
// Teams setup: run setup-teams script
// ---------------------------------------------------------------------------

async function channelAddTeams(
  agentName: string,
  force: boolean,
): Promise<void> {
  const isWindows = process.platform === 'win32';
  const scriptName = isWindows ? 'setup-teams.ps1' : 'setup-teams.sh';
  const scriptPath = path.join(PACKAGE_ROOT, 'scripts', scriptName);

  if (!fs.existsSync(scriptPath)) {
    console.error(`Setup script not found: ${scriptPath}`);
    console.log('Run from a nanoclaw installation directory.');
    return;
  }

  // Use agent name as bot name (sanitized)
  const botName = `nanoclaw-${agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;

  console.log('\nSetting up Teams channel...');
  console.log('  This requires Azure CLI and DevTunnel CLI.');
  console.log(`  Bot name: ${botName}`);
  console.log(`  Running: ${scriptName}\n`);

  try {
    const botNameArg = `-BotName "${botName}"`;
    if (isWindows) {
      execSync(
        `powershell -ExecutionPolicy Bypass -File "${scriptPath}" ${botNameArg}`,
        { stdio: 'inherit', timeout: 600000 },
      );
    } else {
      // setup-teams.sh may not support -BotName yet, pass as env
      execSync(`bash "${scriptPath}"`, {
        stdio: 'inherit',
        timeout: 600000,
        env: { ...process.env, NANOCLAW_BOT_NAME: botName },
      });
    }
    console.log('\n✅ Teams setup complete.');
    console.log('  Restart nanoclaw for changes to take effect.\n');
  } catch (err: any) {
    if (err.status) {
      console.error(`\nTeams setup failed (exit code ${err.status}).`);
    } else {
      console.error(`\nTeams setup failed: ${err.message}`);
    }
    console.log(
      `  Run manually: ${isWindows ? 'powershell' : 'bash'} "${scriptPath}"\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// channel remove
// ---------------------------------------------------------------------------

function channelRemove(name?: string): void {
  if (!name) {
    console.log('Usage: nanoclaw channel remove <name>');
    return;
  }

  const config = loadConfig();
  if ((config.channels as any)?.[name]) {
    (config.channels as any)[name].enabled = false;
    saveConfig(config);
    console.log(`\n✅ ${name} disabled.`);
    console.log('  Restart nanoclaw for changes to take effect.\n');
  } else {
    console.log(`Channel ${name} is not configured.`);
  }
}
