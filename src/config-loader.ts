/**
 * Config loader for nanoclaw.
 * Reads nanoclaw.json from workspace, merges with defaults, reads .env for secrets.
 */

import fs from 'fs';
import { logger } from './logger.js';
import { paths, workspacePath } from './workspace.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentConfig {
  id?: string;
  default?: boolean;
  model: string; // "provider/model" format, e.g. "github-copilot/claude-sonnet-4"
  name: string;
  triggerWord: string;
  hasOwnNumber: boolean;
  mode: 'host' | 'sandbox';
  thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh'; // GHC: --effort flag; CC: --thinking flag
  githubMcp?: boolean; // GHC: register GitHub MCP server (web_search, issues, PRs, etc.)
}

// Per-account credentials for multi-bot support
export interface TelegramAccountConfig {
  botToken?: string;
}

export interface TeamsAccountConfig {
  appId?: string;
  appPassword?: string;
  tenantId?: string;
  webhookPort?: number;
  authMode?: 'secret' | 'certificate';
  certThumbprint?: string;
  certPrivateKeyPath?: string;
}

// Binding: route (channel, accountId, peer) -> agentId
export interface Binding {
  agentId: string;
  match: {
    channel?: string;
    accountId?: string;
    peer?: { kind?: 'direct' | 'group'; id?: string };
  };
}

// New chats format: grouped by channel
export interface ChatEntry {
  jid: string;
  name: string;
  isMain?: boolean;
  requiresTrigger?: boolean;
  agentId?: string;
}

export interface ChannelChats {
  telegram?: ChatEntry[];
  teams?: ChatEntry[];
  discord?: ChatEntry[];
  [channel: string]: ChatEntry[] | undefined;
}

export interface NanoclawConfig {
  agents: {
    defaults: AgentConfig;
    list?: AgentConfig[];
  };
  channels: {
    discord: {
      enabled: boolean;
      botToken?: string;
    };
    telegram: {
      enabled: boolean;
      botToken?: string;
      accounts?: Record<string, TelegramAccountConfig>;
    };
    teams: {
      enabled: boolean;
      appId?: string;
      appPassword?: string;
      tenantId?: string;
      webhookPort: number;
      authMode: 'secret' | 'certificate';
      certThumbprint?: string;
      certPrivateKeyPath?: string;
      accounts?: Record<string, TeamsAccountConfig>;
    };
    [key: string]: { enabled: boolean; [k: string]: unknown };
  };
  mcp: {
    servers: Record<
      string,
      {
        type?: string;
        command?: string;
        args?: string[];
        url?: string;
        headers?: Record<string, string>;
        tools?: string[];
        env?: Record<string, string>;
      }
    >;
  };
  skills: {
    directories: string[];
    disabled: string[];
  };
  sandbox: {
    runtime: 'docker' | 'apple-container';
    image: string;
    timeout: number;
    maxOutputSize: number;
    maxConcurrent: number;
    idleTimeout: number;
  };
  chats: Record<
    string,
    {
      name: string;
      isMain?: boolean;
      requiresTrigger?: boolean;
      agentId?: string;
    }
  >;
  bindings?: Binding[];
  pairing: {
    mode: 'open' | 'prompt' | 'allowlist' | 'disabled';
    notifyChat?: string;
  };
  security?: {
    allowedSenders?: {
      default?: { allow: '*' | string[]; mode?: 'trigger' | 'drop' };
      chats?: Record<
        string,
        { allow: '*' | string[]; mode?: 'trigger' | 'drop' }
      >;
    };
  };
  credentialProxy: {
    port: number;
  };
  logLevel: string;
  timezone: string;
  sendErrorToUser?: boolean; // Send error messages to user on agent failure (default: false)
  tui?: {
    mode?: 'host' | 'sandbox';
    model?: string;
    thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh';
    name?: string;
  };
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: NanoclawConfig = {
  agents: {
    defaults: {
      model: 'github-copilot/claude-sonnet-4',
      name: 'Andy',
      triggerWord: '@Andy',
      hasOwnNumber: false,
      mode: process.platform === 'win32' ? 'host' : 'sandbox',
    },
  },
  channels: {
    discord: { enabled: false },
    telegram: { enabled: false },
    teams: {
      enabled: false,
      webhookPort: 3978,
      authMode: 'secret',
    },
  },
  mcp: { servers: {} },
  skills: {
    directories: ['./skills'],
    disabled: [],
  },
  sandbox: {
    runtime: 'docker',
    image: 'nanoclaw-agent:latest',
    timeout: 1800000,
    maxOutputSize: 10485760,
    maxConcurrent: 5,
    idleTimeout: 0,
  },
  chats: {},
  pairing: { mode: 'disabled' },
  credentialProxy: { port: 3001 },
  logLevel: 'info',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

// ─── Loader ──────────────────────────────────────────────────────────────────

/**
 * Deep merge: target values overridden by source values.
 */
function deepMerge(target: any, source: any): any {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (
      source[key] &&
      typeof source[key] === 'object' &&
      !Array.isArray(source[key]) &&
      target[key] &&
      typeof target[key] === 'object' &&
      !Array.isArray(target[key])
    ) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

/**
 * Read .env file from workspace and return key-value pairs.
 */
export function readWorkspaceEnv(): Record<string, string> {
  const envPath = paths.env;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (value) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Load nanoclaw.json from workspace, merge with defaults.
 * Secrets from .env are merged into the appropriate config sections.
 */
/**
 * Convert channel-grouped chats format to flat Record<jid, config> format.
 * Supports both old (flat) and new (grouped) formats.
 */
function normalizeChats(raw: any): Record<
  string,
  {
    name: string;
    isMain?: boolean;
    requiresTrigger?: boolean;
    agentId?: string;
  }
> {
  if (!raw || typeof raw !== 'object') return {};

  // Check if it's the new grouped format (has telegram/teams/discord arrays)
  const channelKeys = ['telegram', 'teams', 'discord', 'slack', 'whatsapp'];
  const isGrouped = Object.keys(raw).some(
    (k) => channelKeys.includes(k) && Array.isArray(raw[k]),
  );

  if (isGrouped) {
    const result: Record<string, any> = {};
    for (const [, entries] of Object.entries(raw)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry.jid && entry.name) {
          result[entry.jid] = {
            name: entry.name,
            isMain: entry.isMain,
            requiresTrigger: entry.requiresTrigger,
            agentId: entry.agentId,
          };
        }
      }
    }
    return result;
  }

  // Old flat format — return as-is
  return raw;
}

/**
 * Convert flat Record<jid, config> back to channel-grouped format for saving.
 */
function denormalizeChats(flat: Record<string, any>): ChannelChats {
  const grouped: ChannelChats = {};
  for (const [jid, config] of Object.entries(flat)) {
    let channel = 'other';
    if (jid.startsWith('tg:')) channel = 'telegram';
    else if (jid.startsWith('teams:')) channel = 'teams';
    else if (jid.startsWith('dc:')) channel = 'discord';
    else if (jid.startsWith('wa:')) channel = 'whatsapp';
    else if (jid.startsWith('slack:')) channel = 'slack';

    if (!grouped[channel]) grouped[channel] = [];
    grouped[channel]!.push({
      jid,
      name: config.name,
      isMain: config.isMain,
      requiresTrigger: config.requiresTrigger,
      agentId: config.agentId,
    });
  }
  return grouped;
}

export function loadConfig(): NanoclawConfig {
  let userConfig: Partial<NanoclawConfig> = {};

  // Read nanoclaw.json
  try {
    if (fs.existsSync(paths.config)) {
      const raw = fs.readFileSync(paths.config, 'utf-8');
      userConfig = JSON.parse(raw);
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to read nanoclaw.json, using defaults',
    );
  }

  // Merge with defaults
  const config = deepMerge(DEFAULTS, userConfig) as NanoclawConfig;

  // Normalize chats: convert grouped format to flat Record<jid, config>
  config.chats = normalizeChats(config.chats) as any;

  // Merge MCP servers from mcp.json if it exists
  if (fs.existsSync(paths.mcpConfig)) {
    try {
      const mcpJson = JSON.parse(fs.readFileSync(paths.mcpConfig, 'utf-8'));
      const mcpServers = mcpJson.mcpServers || mcpJson;
      // mcp.json servers are base, nanoclaw.json servers override
      config.mcp.servers = { ...mcpServers, ...config.mcp.servers };
    } catch {
      // ignore
    }
  }

  // Read .env and fill in secrets where config doesn't have them
  const env = readWorkspaceEnv();

  // Telegram
  if (!config.channels.telegram.botToken) {
    config.channels.telegram.botToken =
      process.env.TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  }

  // Teams
  const teams = config.channels.teams;
  if (!teams.appId) {
    teams.appId = process.env.MSTEAMS_APP_ID || env.MSTEAMS_APP_ID;
  }
  if (!teams.appPassword) {
    teams.appPassword =
      process.env.MSTEAMS_APP_PASSWORD ||
      env.MSTEAMS_APP_PASSWORD ||
      process.env.MSTEAMS_APP_KEY ||
      env.MSTEAMS_APP_KEY;
  }
  if (!teams.tenantId) {
    teams.tenantId = process.env.MSTEAMS_TENANT_ID || env.MSTEAMS_TENANT_ID;
  }
  if (!teams.certThumbprint) {
    teams.certThumbprint =
      process.env.MSTEAMS_CERT_THUMBPRINT || env.MSTEAMS_CERT_THUMBPRINT;
  }
  if (!teams.certPrivateKeyPath) {
    teams.certPrivateKeyPath =
      process.env.MSTEAMS_CERT_PRIVATE_KEY_PATH ||
      env.MSTEAMS_CERT_PRIVATE_KEY_PATH;
  }

  // Auto-enable channels if credentials are present
  if (
    config.channels.telegram.botToken &&
    !userConfig.channels?.telegram?.enabled
  ) {
    config.channels.telegram.enabled = true;
  }
  if (teams.appId && (teams.appPassword || teams.certThumbprint)) {
    if (!userConfig.channels?.teams?.enabled) {
      config.channels.teams.enabled = true;
    }
  }

  // Normalize channel credentials: old flat format → accounts.default
  // This ensures channel factories always read from accounts{}
  const tg = config.channels.telegram;
  if (tg.botToken && !tg.accounts) {
    tg.accounts = { default: { botToken: tg.botToken } };
  }
  const tm = config.channels.teams;
  if (tm.appId && !tm.accounts) {
    tm.accounts = {
      default: {
        appId: tm.appId,
        appPassword: tm.appPassword,
        tenantId: tm.tenantId,
        webhookPort: tm.webhookPort,
        authMode: tm.authMode,
        certThumbprint: tm.certThumbprint,
        certPrivateKeyPath: tm.certPrivateKeyPath,
      },
    };
  }

  return config;
}

/**
 * Save config back to nanoclaw.json (for CLI commands like chat add).
 */
export function saveConfig(config: NanoclawConfig): void {
  // Strip secrets before saving — they stay in .env
  const toSave = JSON.parse(JSON.stringify(config));
  if (toSave.channels?.telegram) {
    delete toSave.channels.telegram.botToken;
  }
  if (toSave.channels?.teams) {
    delete toSave.channels.teams.appId;
    delete toSave.channels.teams.appPassword;
    delete toSave.channels.teams.certThumbprint;
    delete toSave.channels.teams.certPrivateKeyPath;
  }

  // Save chats in grouped format
  toSave.chats = denormalizeChats(toSave.chats || {});
  fs.writeFileSync(paths.config, JSON.stringify(toSave, null, 2) + '\n');
}

// ─── Agent Resolution ────────────────────────────────────────────────────────

/**
 * Resolve agent config for a given agentId.
 * If agentId is provided, looks in agents.list[]. Falls back to agents.defaults.
 * List entries inherit missing fields from defaults.
 */
export function resolveAgent(
  config: NanoclawConfig,
  agentId?: string,
): AgentConfig {
  const defaults = config.agents.defaults;
  if (!agentId || !config.agents.list?.length) {
    return defaults;
  }
  const found = config.agents.list.find((a) => a.id === agentId);
  if (!found) {
    return defaults;
  }
  // Merge: agent-specific overrides defaults
  return { ...defaults, ...found };
}

/**
 * Resolve agentId from bindings for a given chat.
 * Checks bindings[] in order; first match wins.
 * Falls back to chatConfig.agentId (legacy) or undefined (use default agent).
 */
export function resolveAgentIdFromBindings(
  config: NanoclawConfig,
  chatJid: string,
  chatConfig?: { agentId?: string },
): string | undefined {
  if (config.bindings?.length) {
    // Derive channel and accountId from JID
    // Format: tg:<chatId> (default account) or tg:<accountId>:<chatId>
    let channel: string | undefined;
    let jidAccountId: string | undefined;
    if (chatJid.startsWith('tg:')) {
      channel = 'telegram';
      const parts = chatJid.split(':');
      if (parts.length >= 3) jidAccountId = parts[1]; // tg:accountId:chatId
    } else if (chatJid.startsWith('teams:')) {
      channel = 'teams';
    } else if (chatJid.startsWith('dc:')) {
      channel = 'discord';
    } else if (chatJid.startsWith('wa:')) {
      channel = 'whatsapp';
    }

    for (const binding of config.bindings) {
      const m = binding.match;
      if (m.channel && m.channel !== channel) continue;
      if (m.accountId) {
        // Match accountId: 'default' matches JIDs without accountId prefix
        const effective = jidAccountId || 'default';
        if (m.accountId !== effective) continue;
      }
      if (m.peer?.id && !chatJid.includes(m.peer.id)) continue;
      return binding.agentId;
    }
  }

  // Legacy: chatConfig.agentId
  return chatConfig?.agentId;
}

/**
 * Get the default agent (first with default: true, or first in list, or defaults).
 */
export function getDefaultAgent(config: NanoclawConfig): AgentConfig {
  const list = config.agents.list;
  if (!list?.length) return config.agents.defaults;
  const defaultAgent = list.find((a) => a.default);
  return defaultAgent
    ? { ...config.agents.defaults, ...defaultAgent }
    : { ...config.agents.defaults, ...list[0] };
}
