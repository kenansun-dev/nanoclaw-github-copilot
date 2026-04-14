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
import { setupManifest } from './teams-manifest.js';

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

function parseFlags(args: string[]): {
  agent?: string;
  account?: string;
  setup: boolean;
  setupTunnel: boolean;
  setupApp: boolean;
  setupBot: boolean;
  setupManifest: boolean;
  force: boolean;
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  botToken?: string;
  webhookPort?: number;
} {
  let agent: string | undefined;
  let account: string | undefined;
  let setup = false;
  let setupTunnel = false;
  let setupApp = false;
  let setupBot = false;
  let setupManifest = false;
  let force = false;
  let appId: string | undefined;
  let appPassword: string | undefined;
  let tenantId: string | undefined;
  let botToken: string | undefined;
  let webhookPort: number | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--agent' && args[i + 1]) {
      agent = args[++i];
    } else if (args[i] === '--account' && args[i + 1]) {
      account = args[++i];
    } else if (args[i] === '--setup') {
      setup = true;
    } else if (args[i] === '--setup-tunnel') {
      setupTunnel = true;
    } else if (args[i] === '--setup-app') {
      setupApp = true;
    } else if (args[i] === '--setup-bot') {
      setupBot = true;
    } else if (args[i] === '--setup-manifest') {
      setupManifest = true;
    } else if (args[i] === '--force') {
      force = true;
    } else if (args[i] === '--appId' && args[i + 1]) {
      appId = args[++i];
    } else if (args[i] === '--appPassword' && args[i + 1]) {
      appPassword = args[++i];
    } else if (args[i] === '--tenantId' && args[i + 1]) {
      tenantId = args[++i];
    } else if (args[i] === '--botToken' && args[i + 1]) {
      botToken = args[++i];
    } else if (args[i] === '--webhookPort' && args[i + 1]) {
      webhookPort = parseInt(args[++i], 10);
    }
  }
  return {
    agent,
    account,
    setup,
    setupTunnel,
    setupApp,
    setupBot,
    setupManifest,
    force,
    appId,
    appPassword,
    tenantId,
    botToken,
    webhookPort,
  };
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
    console.log(
      'Usage: nanoclaw channel add <name> [--account <id>] [--setup] [--setup-tunnel] [--agent <id>] [--force]',
    );
    console.log(
      '       nanoclaw channel add teams --appId xxx --appPassword yyy [--account bot-b]',
    );
    console.log(
      '       nanoclaw channel add telegram --botToken xxx [--account daily]',
    );
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
  const accountId = flags.account || 'default';

  // Resolve agent
  const config = loadConfig();
  const agentId = flags.agent;
  if (agentId) {
    const agentList = config.agents?.list || [];
    const found = agentList.find((a: any) => a.id === agentId);
    if (!found) {
      console.error(
        `Agent '${agentId}' not found in config. Add it to agents.list first.`,
      );
      return;
    }
  }

  // Validate mutually exclusive flags
  if (flags.setup && (flags.appId || flags.botToken)) {
    console.error(
      'Error: --setup and --appId/--botToken are mutually exclusive.',
    );
    console.log(
      '  Use --setup to provision new resources, OR pass credentials directly.',
    );
    return;
  }

  // Teams with --setup: run all steps in order (tunnel → app → bot → manifest)
  if (channelName === 'teams' && flags.setup) {
    const agent = resolveAgent(config, agentId);
    const agentName = agent.name || agentId || 'default';
    const botName = `nanoclaw-${agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    await channelSetupTunnel();
    const appResult = await setupApp(botName);
    if (!appResult) return;
    const tunnelUrl = await getTunnelUrlForSetup();
    if (tunnelUrl) {
      await setupBot(
        botName,
        appResult.appId,
        appResult.appPassword,
        tunnelUrl,
      );
    }
    await setupManifest(appResult.appId, botName);
    return;
  }

  // Teams with --setup-tunnel: only set up devtunnel
  if (channelName === 'teams' && flags.setupTunnel) {
    return channelSetupTunnel();
  }

  // Teams with --setup-app: only create Azure AD App Registration
  if (channelName === 'teams' && flags.setupApp) {
    const agent = resolveAgent(config, agentId);
    const agentName = agent.name || agentId || 'default';
    const botName = `nanoclaw-${agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    await setupApp(botName);
    return;
  }

  // Teams with --setup-bot: only create Azure Bot
  if (channelName === 'teams' && flags.setupBot) {
    const agent = resolveAgent(config, agentId);
    const agentName = agent.name || agentId || 'default';
    const botName = `nanoclaw-${agentName.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`;
    const cfg = loadConfig();
    const appId =
      cfg.channels.teams.accounts?.default?.appId || cfg.channels.teams.appId;
    const appPassword =
      cfg.channels.teams.accounts?.default?.appPassword ||
      cfg.channels.teams.appPassword;
    if (!appId || !appPassword) {
      console.error(
        'Error: appId and appPassword required. Run --setup-app first or set them in config.',
      );
      return;
    }
    const tunnelUrl = await getTunnelUrlForSetup();
    if (!tunnelUrl) {
      console.error(
        'Error: Could not determine tunnel URL. Run --setup-tunnel first.',
      );
      return;
    }
    await setupBot(botName, appId, appPassword, tunnelUrl);
    return;
  }

  // Teams with --setup-manifest: only generate Teams App manifest zip
  if (channelName === 'teams' && flags.setupManifest) {
    const cfg = loadConfig();
    const appId =
      cfg.channels.teams.accounts?.default?.appId || cfg.channels.teams.appId;
    if (!appId) {
      console.error(
        'Error: appId required. Run --setup-app first or set it in config.',
      );
      return;
    }
    const agent = resolveAgent(cfg, agentId);
    const botName = agent.name || cfg.agents?.defaults?.name || 'Nanoclaw';
    await setupManifest(appId, botName);
    return;
  }

  // Direct credentials via flags (non-interactive)
  if (channelName === 'teams' && flags.appId) {
    return channelAddDirect(channelName, accountId, {
      appId: flags.appId,
      appPassword: flags.appPassword,
      tenantId: flags.tenantId,
      webhookPort: flags.webhookPort,
    });
  }
  if (channelName === 'telegram' && flags.botToken) {
    return channelAddDirect(channelName, accountId, {
      botToken: flags.botToken,
    });
  }

  // Interactive credential input
  return channelAddInteractive(channelName, accountId);
}

// ---------------------------------------------------------------------------
// Interactive credential input (Telegram, etc.)
// ---------------------------------------------------------------------------

async function channelAddInteractive(
  channelName: ChannelName,
  accountId: string,
): Promise<void> {
  const fields = CHANNEL_FIELDS[channelName];

  if (!process.stdin.isTTY) {
    console.log('Interactive mode required. Run from a terminal.');
    console.log(
      `  Or use flags: nanoclaw channel add ${channelName} --account ${accountId} --${fields[0].key} <value>`,
    );
    return;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log(`\nConfiguring ${channelName} (account: ${accountId}):\n`);

  const credentials: Record<string, any> = {};

  for (const field of fields) {
    const requiredHint = field.required ? ' *' : '';
    const value = await ask(`  ${field.prompt}${requiredHint}: `);
    if (value.trim()) {
      credentials[field.key] = value.trim();
    }
  }

  rl.close();

  return channelAddDirect(channelName, accountId, credentials);
}

// ---------------------------------------------------------------------------
// Direct credential write (non-interactive)
// ---------------------------------------------------------------------------

function channelAddDirect(
  channelName: ChannelName,
  accountId: string,
  credentials: Record<string, any>,
): void {
  const config = loadConfig();
  config.channels = config.channels || {};

  const channelConfig: Record<string, any> =
    (config.channels as any)[channelName] || {};
  channelConfig.enabled = true;

  // Write credentials to accounts.<accountId>
  if (!channelConfig.accounts) {
    channelConfig.accounts = {};
  }
  const existingAccount = channelConfig.accounts[accountId] || {};
  channelConfig.accounts[accountId] = { ...existingAccount, ...credentials };

  (config.channels as any)[channelName] = channelConfig;
  saveConfig(config);

  console.log(
    `\n✅ ${channelName} account '${accountId}' configured in nanoclaw.json`,
  );
  console.log('  Restart nanoclaw for changes to take effect.\n');
}

// ---------------------------------------------------------------------------
// Teams setup sub-steps
// ---------------------------------------------------------------------------

function runCmd(
  cmd: string,
  opts?: { silent?: boolean },
): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 60000,
    }).trim();
    return { ok: true, output };
  } catch (err: any) {
    const output =
      (err.stdout || '').toString().trim() +
      '\n' +
      (err.stderr || '').toString().trim();
    return { ok: false, output: output.trim() };
  }
}

/**
 * --setup-app: Create Azure AD App Registration (appId + appPassword).
 * Reuses existing app if found by display name.
 */
async function setupApp(
  botName: string,
): Promise<{ appId: string; appPassword: string } | null> {
  console.log(`\n🔑 Setting up Azure AD App Registration '${botName}'...`);

  // Check Azure CLI
  const azCheck = runCmd('az account show --query name -o tsv');
  if (!azCheck.ok) {
    console.error('  ❌ Not logged in to Azure CLI. Run: az login');
    return null;
  }
  console.log(`  ✅ Azure CLI: ${azCheck.output}`);

  // Check if app already exists
  const existingApp = runCmd(
    `az ad app list --display-name "${botName}" --query "[0].appId" -o tsv`,
  );
  let appId: string;
  let appPassword: string;

  if (existingApp.ok && existingApp.output) {
    appId = existingApp.output;
    console.log(`  Found existing app: ${appId}`);
    console.log('  Rotating client secret...');
    const resetResult = runCmd(
      `az ad app credential reset --id "${appId}" --years 2 --query "password" -o tsv`,
    );
    if (!resetResult.ok) {
      console.error(`  ❌ Failed to rotate secret: ${resetResult.output}`);
      return null;
    }
    appPassword = resetResult.output;
    console.log('  ✅ Secret rotated.');
  } else {
    const createResult = runCmd(
      `az ad app create --display-name "${botName}" --sign-in-audience AzureADMyOrg --query "appId" -o tsv`,
    );
    if (!createResult.ok) {
      console.error(`  ❌ Failed to create app: ${createResult.output}`);
      return null;
    }
    appId = createResult.output;
    console.log(`  Created app: ${appId}`);
    const resetResult = runCmd(
      `az ad app credential reset --id "${appId}" --years 2 --query "password" -o tsv`,
    );
    if (!resetResult.ok) {
      console.error(`  ❌ Failed to create secret: ${resetResult.output}`);
      return null;
    }
    appPassword = resetResult.output;
    console.log('  ✅ App + secret created.');
  }

  // Write credentials to config
  const config = loadConfig();
  if (!config.channels.teams.accounts) config.channels.teams.accounts = {};
  const acct = config.channels.teams.accounts.default || ({} as any);
  acct.appId = appId;
  acct.appPassword = appPassword;
  config.channels.teams.accounts.default = acct;
  config.channels.teams.enabled = true;
  saveConfig(config);

  // Also write to .env
  const { paths: wsPaths } = await import('../workspace.js');
  const envPath = wsPaths.env;
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf-8');
  } catch {}
  const envLines = envContent.split('\n');
  const setEnv = (key: string, value: string) => {
    const idx = envLines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) envLines[idx] = `${key}=${value}`;
    else envLines.push(`${key}=${value}`);
  };
  setEnv('MSTEAMS_APP_ID', appId);
  setEnv('MSTEAMS_APP_PASSWORD', appPassword);
  fs.writeFileSync(envPath, envLines.join('\n'));
  console.log(`  ✅ Credentials saved to .env and nanoclaw.json`);

  return { appId, appPassword };
}

/**
 * --setup-bot: Create Azure Bot resource (requires appId + tunnel URL).
 */
async function setupBot(
  botName: string,
  appId: string,
  appPassword: string,
  tunnelUrl: string,
): Promise<void> {
  const resourceGroup = 'nanoclaw-rg';
  const location = 'eastus';
  const messagingEndpoint = `${tunnelUrl}/api/messages`;

  console.log(`\n🤖 Setting up Azure Bot '${botName}'...`);

  // Ensure resource group
  const rgCheck = runCmd(`az group show --name "${resourceGroup}"`, {
    silent: true,
  });
  if (!rgCheck.ok) {
    console.log(`  Creating resource group '${resourceGroup}'...`);
    const rgCreate = runCmd(
      `az group create --name "${resourceGroup}" --location "${location}" --output none`,
    );
    if (!rgCreate.ok) {
      console.error(`  ❌ Failed to create resource group: ${rgCreate.output}`);
      return;
    }
  }

  // Check if bot already exists
  const existingBot = runCmd(
    `az bot show --name "${botName}" --resource-group "${resourceGroup}" --query "name" -o tsv`,
    { silent: true },
  );
  if (existingBot.ok && existingBot.output) {
    console.log('  Found existing bot. Updating endpoint...');
    runCmd(
      `az bot update --name "${botName}" --resource-group "${resourceGroup}" --endpoint "${messagingEndpoint}" --output none`,
    );
    console.log('  ✅ Bot endpoint updated.');
  } else {
    console.log('  Creating bot...');
    const createResult = runCmd(
      `az bot create --name "${botName}" --resource-group "${resourceGroup}" --app-type SingleTenant --appid "${appId}" --password "${appPassword}" --endpoint "${messagingEndpoint}" --sku F0 --output none`,
    );
    if (!createResult.ok) {
      console.error(
        `  ❌ Bot creation may have failed: ${createResult.output}`,
      );
    } else {
      console.log('  ✅ Bot created.');
    }
  }

  // Enable Teams channel on the bot
  console.log('  Enabling Teams channel...');
  runCmd(
    `az bot msteams create --name "${botName}" --resource-group "${resourceGroup}" --output none`,
  );
  console.log('  ✅ Teams channel enabled.');
  console.log(`  ✅ Messaging endpoint: ${messagingEndpoint}`);
}

/**
 * Helper to get tunnel URL for --setup-bot.
 */
async function getTunnelUrlForSetup(): Promise<string | null> {
  // Try devtunnel show for nanoclaw tunnel
  const listResult = runCmd('devtunnel list');
  if (!listResult.ok) return null;

  let tunnelId: string | null = null;
  for (const line of listResult.output.split('\n')) {
    if (line.toLowerCase().includes('nanoclaw')) {
      const match = line.match(/([a-zA-Z0-9._-]+)/);
      if (match) {
        tunnelId = match[1];
        break;
      }
    }
  }
  if (!tunnelId) return null;

  const showResult = runCmd(`devtunnel show ${tunnelId}`);
  if (!showResult.ok) return null;

  const urlMatch = showResult.output.match(
    /https?:\/\/[a-zA-Z0-9._-]+\.devtunnels\.ms[^\s]*/,
  );
  return urlMatch ? urlMatch[0].replace(/\/+$/, '') : null;
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

// ---------------------------------------------------------------------------
// Teams: devtunnel setup (--setup-tunnel)
// ---------------------------------------------------------------------------

async function channelSetupTunnel(): Promise<void> {
  const { setupTeamsTunnel } = await import('./tunnel.js');
  return setupTeamsTunnel();
}
