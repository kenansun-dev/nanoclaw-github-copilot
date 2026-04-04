/**
 * nanoclaw channel — manage channel configuration
 *
 * Usage:
 *   nanoclaw channel list           — show configured channels
 *   nanoclaw channel add <name>     — interactively configure a channel
 *   nanoclaw channel remove <name>  — disable a channel
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';

import { loadConfig, saveConfig } from '../config-loader.js';
import { resolveWorkspace } from '../workspace.js';

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
    {
      key: 'webhookPort',
      prompt: 'Webhook port (default: 3978)',
      required: false,
    },
    {
      key: 'certThumbprint',
      prompt: 'Certificate thumbprint (if using cert auth, otherwise skip)',
      required: false,
    },
    {
      key: 'certPrivateKeyPath',
      prompt: 'Certificate private key path (if using cert auth)',
      required: false,
    },
  ],
};

export async function runChannelCommand(args: string[]): Promise<void> {
  const subcommand = args[0] || 'list';

  switch (subcommand) {
    case 'list':
      return channelList();
    case 'add':
      return channelAdd(args[1]);
    case 'remove':
      return channelRemove(args[1]);
    default:
      console.log('Usage: nanoclaw channel <list|add|remove> [name]');
      console.log('Channels: ' + SUPPORTED_CHANNELS.join(', '));
  }
}

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

async function channelAdd(name?: string): Promise<void> {
  if (!name) {
    console.log('Usage: nanoclaw channel add <name>');
    console.log('Available: ' + SUPPORTED_CHANNELS.join(', '));
    return;
  }

  if (!SUPPORTED_CHANNELS.includes(name as ChannelName)) {
    console.error(`Unknown channel: ${name}`);
    console.log('Available: ' + SUPPORTED_CHANNELS.join(', '));
    return;
  }

  const channelName = name as ChannelName;
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
      // Parse numbers for port
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
