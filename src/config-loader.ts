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
  provider?: string; // e.g. "github-copilot", "anthropic". If omitted, parsed from model string.
  model: string; // Short name (e.g. "claude-sonnet-4") or FQDN "provider/model" for backward compat
  name: string;
  triggerWord: string;
  hasOwnNumber: boolean;
  mode: 'host' | 'sandbox';
  thinkLevel?: 'low' | 'medium' | 'high' | 'xhigh'; // GHC: --effort flag; CC: --thinking flag
  showThinking?: boolean; // Show thinking/reasoning in channel messages (default: false)
  timeoutSeconds?: number; // Max agent run duration in seconds (default: 600 = 10 min). 0 = no timeout.
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
  configVersion?: number;
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
    engine?: 'node' | 'tsx'; // node = compiled dist (default), tsx = self-modifying
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
  addons?: Record<
    string,
    {
      type: string; // 'devtunnel' | 'azure-app' | 'azure-bot' | 'scheduled-task'
      channel?: string; // which channel this addon belongs to (e.g. 'teams')
      enabled: boolean;
      config: Record<string, unknown>;
      createdAt?: string;
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
      provider: 'github-copilot',
      model: 'claude-sonnet-4',
      name: 'Andy',
      triggerWord: '@Andy',
      hasOwnNumber: false,
      mode: process.platform === 'win32' ? 'host' : 'sandbox',
      timeoutSeconds: 600, // 10 minutes default
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
    engine: 'node' as const,
  },
  chats: {},
  addons: {},
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
 * Derive channel name from a chat jid prefix.
 */
function channelFromJid(jid: string): string {
  if (jid.startsWith('tg:')) return 'telegram';
  if (jid.startsWith('teams:')) return 'teams';
  if (jid.startsWith('dc:')) return 'discord';
  if (jid.startsWith('wa:')) return 'whatsapp';
  if (jid.startsWith('slack:')) return 'slack';
  return 'other';
}

/**
 * Convert channel-grouped chats format to flat Record<jid, config> format.
 * Supports:
 * - Old top-level flat format: { "teams:xxx": { name: "..." } }
 * - Grouped format (top-level chats): { telegram: [...], teams: [...] }
 * - Channel-embedded format: read from channels.<name>.chats arrays
 */
function normalizeChats(
  raw: any,
  channels?: any,
): Record<
  string,
  {
    name: string;
    isMain?: boolean;
    requiresTrigger?: boolean;
    agentId?: string;
  }
> {
  const result: Record<string, any> = {};

  // 1. Read from channels.<name>.chats (new canonical format)
  if (channels && typeof channels === 'object') {
    for (const [, chDef] of Object.entries(channels) as any[]) {
      if (!chDef || !Array.isArray(chDef.chats)) continue;
      for (const entry of chDef.chats) {
        if (entry.jid) {
          result[entry.jid] = {
            name: entry.name || entry.jid,
            isMain: entry.isMain,
            requiresTrigger: entry.requiresTrigger,
            agentId: entry.agentId,
          };
        }
      }
    }
  }

  // 2. Also read from top-level chats (migration support)
  if (raw && typeof raw === 'object') {
    const channelKeys = [
      'telegram',
      'teams',
      'discord',
      'slack',
      'whatsapp',
      'other',
    ];
    const isGrouped = Object.keys(raw).some(
      (k) => channelKeys.includes(k) && Array.isArray(raw[k]),
    );

    if (isGrouped) {
      for (const [, entries] of Object.entries(raw)) {
        if (!Array.isArray(entries)) continue;
        for (const entry of entries) {
          if (entry.jid && !result[entry.jid]) {
            result[entry.jid] = {
              name: entry.name || entry.jid,
              isMain: entry.isMain,
              requiresTrigger: entry.requiresTrigger,
              agentId: entry.agentId,
            };
          }
        }
      }
    } else {
      // Old flat format
      for (const [jid, cfg] of Object.entries(raw) as any[]) {
        if (!result[jid]) {
          result[jid] = cfg;
        }
      }
    }
  }

  return result;
}

/**
 * Write chats into channels.<name>.chats arrays for saving.
 * Removes top-level "chats" key.
 */
function distributeChatsToChannels(
  toSave: any,
  flat: Record<string, any>,
): void {
  // Remove top-level chats
  delete toSave.chats;

  // Group by channel
  const byChannel: Record<string, any[]> = {};
  for (const [jid, config] of Object.entries(flat)) {
    const ch = channelFromJid(jid);
    if (!byChannel[ch]) byChannel[ch] = [];
    byChannel[ch].push({
      jid,
      name: config.name,
      isMain: config.isMain,
      requiresTrigger: config.requiresTrigger,
      agentId: config.agentId,
    });
  }

  // Write into channels.<name>.chats
  if (!toSave.channels) toSave.channels = {};
  for (const [ch, entries] of Object.entries(byChannel)) {
    if (!toSave.channels[ch]) toSave.channels[ch] = { enabled: false };
    toSave.channels[ch].chats = entries;
  }
  // Clean up channels that no longer have chats
  for (const [ch, chDef] of Object.entries(toSave.channels) as any[]) {
    if (chDef && typeof chDef === 'object' && chDef.chats && !byChannel[ch]) {
      delete chDef.chats;
    }
  }
}

// ─── Config Migration ────────────────────────────────────────────────────────

const CURRENT_CONFIG_VERSION = 3;

/**
 * Migrate config from older versions. Returns true if migration occurred.
 */
function migrateConfig(config: Record<string, any>): boolean {
  const version = config.configVersion || 0;
  if (version >= CURRENT_CONFIG_VERSION) return false;

  let migrated = false;

  // v0 → v1: normalize structure
  if (version < 1) {
    // Ensure chats registered without isMain get isMain: true (personal use default)
    if (config.chats) {
      const chats =
        typeof config.chats === 'object' && !Array.isArray(config.chats)
          ? config.chats
          : {};
      for (const [channel, chatList] of Object.entries(chats)) {
        if (Array.isArray(chatList)) {
          for (const chat of chatList as any[]) {
            if (chat.isMain === undefined) {
              chat.isMain = true;
              migrated = true;
            }
          }
        }
      }
    }

    // Ensure sandbox.engine defaults to 'node'
    if (config.sandbox && !config.sandbox.engine) {
      config.sandbox.engine = 'node';
      migrated = true;
    }

    config.configVersion = 1;
    migrated = true;
  }

  // v1 → v2: split "provider/model" into separate provider + model fields
  if (version < 2) {
    const splitProviderModel = (agent: any) => {
      if (agent && agent.model && !agent.provider) {
        const slash = agent.model.indexOf('/');
        if (slash > 0) {
          agent.provider = agent.model.substring(0, slash);
          agent.model = agent.model.substring(slash + 1);
          migrated = true;
        }
      }
    };

    if (config.agents?.defaults) {
      splitProviderModel(config.agents.defaults);
    }
    if (Array.isArray(config.agents?.list)) {
      for (const agent of config.agents.list) {
        splitProviderModel(agent);
      }
    }
    // Also migrate tui.model if present
    if (config.tui?.model) {
      const slash = config.tui.model.indexOf('/');
      if (slash > 0) {
        config.tui.model = config.tui.model.substring(slash + 1);
        migrated = true;
      }
    }

    config.configVersion = 2;
    migrated = true;
  }

  // v2 → v3: move root-level teams.tenantId into accounts.default.tenantId
  if (version < 3) {
    const teams = config.channels?.teams;
    if (teams && teams.tenantId) {
      if (!teams.accounts) teams.accounts = {};
      if (!teams.accounts.default) teams.accounts.default = {};
      if (!teams.accounts.default.tenantId) {
        teams.accounts.default.tenantId = teams.tenantId;
      }
      delete teams.tenantId;
      migrated = true;
    }
    config.configVersion = 3;
    migrated = true;
  }

  return migrated;
}

/**
 * Recursively resolve ${VAR_NAME} placeholders in string values.
 * envMap is the merged .env + process.env (workspace .env takes priority).
 */
function resolveEnvVars(
  obj: any,
  envMap: Record<string, string | undefined>,
): any {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (match, varName) => {
      const value = envMap[varName];
      if (value !== undefined) return value;
      logger.warn(
        { var: varName },
        `Env var \${${varName}} not found, leaving as-is`,
      );
      return match;
    });
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => resolveEnvVars(item, envMap));
  }
  if (obj && typeof obj === 'object') {
    const result: Record<string, any> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = resolveEnvVars(value, envMap);
    }
    return result;
  }
  return obj;
}

// ─── Load / Save ─────────────────────────────────────────────────────────────

export function loadConfig(): NanoclawConfig {
  let userConfig: Partial<NanoclawConfig> = {};
  let recoveredFromBackup = false;

  // Read nanoclaw.json
  try {
    if (fs.existsSync(paths.config)) {
      const raw = fs.readFileSync(paths.config, 'utf-8');
      userConfig = JSON.parse(raw);
    }
  } catch (err) {
    logger.error(
      { err: err instanceof Error ? err.message : String(err) },
      'Failed to parse nanoclaw.json — attempting recovery from backup',
    );
    // Try to recover from .bak files
    const recovered = recoverFromBackup(paths.config);
    if (recovered) {
      userConfig = recovered;
      recoveredFromBackup = true;
      console.error(
        '\n  ⚠️  nanoclaw.json was corrupt — recovered from backup.\n' +
          `  File: ${paths.config}\n`,
      );
    } else {
      console.error(
        '\n  ❌ nanoclaw.json is invalid JSON and no backup found.\n' +
          '  Fix the file manually before starting.\n' +
          `  File: ${paths.config}\n`,
      );
      process.exit(1);
    }
  }

  // Migrate secrets from nanoclaw.json to .env (one-time)
  // Skip if we just recovered from backup to avoid circular corruption
  if (!recoveredFromBackup) {
    migrateSecretsToEnv(userConfig);
  }

  // Run config migrations
  const migrated = migrateConfig(userConfig);
  if (migrated && !recoveredFromBackup) {
    try {
      fs.writeFileSync(
        paths.config,
        JSON.stringify(userConfig, null, 2) + '\n',
      );
      logger.debug(
        { version: userConfig.configVersion },
        'Config migrated and saved',
      );
    } catch {
      /* best effort */
    }
  }

  // Resolve ${VAR_NAME} env var placeholders in config values
  const wsEnv = readWorkspaceEnv();
  const envMap: Record<string, string | undefined> = {
    ...process.env,
    ...wsEnv,
  };
  userConfig = resolveEnvVars(userConfig, envMap);

  // Merge with defaults
  const config = deepMerge(DEFAULTS, userConfig) as NanoclawConfig;

  // Normalize chats: convert grouped format to flat Record<jid, config>
  config.chats = normalizeChats(config.chats, config.channels) as any;

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
  if (tm.appId) {
    if (!tm.accounts) tm.accounts = {};
    const acct = tm.accounts.default || ({} as TeamsAccountConfig);
    tm.accounts.default = {
      appId: acct.appId || tm.appId,
      appPassword: acct.appPassword || tm.appPassword,
      tenantId: acct.tenantId || tm.tenantId,
      webhookPort: acct.webhookPort || tm.webhookPort,
      authMode: acct.authMode || tm.authMode,
      certThumbprint: acct.certThumbprint || tm.certThumbprint,
      certPrivateKeyPath: acct.certPrivateKeyPath || tm.certPrivateKeyPath,
    };
  }

  return config;
}

// ─── Config Backup ───────────────────────────────────────────────────────────

const MAX_BACKUP_RING = 4;

/** Rotate .bak ring: .bak → .bak.1, .bak.1 → .bak.2, ... up to .bak.4 */
function rotateConfigBackups(configPath: string): void {
  const bakBase = `${configPath}.bak`;
  // Remove oldest
  try {
    fs.unlinkSync(`${bakBase}.${MAX_BACKUP_RING}`);
  } catch {}
  // Shift ring
  for (let i = MAX_BACKUP_RING - 1; i >= 1; i--) {
    try {
      fs.renameSync(`${bakBase}.${i}`, `${bakBase}.${i + 1}`);
    } catch {}
  }
  // Current .bak → .bak.1
  try {
    fs.renameSync(bakBase, `${bakBase}.1`);
  } catch {}
}

/** Create a backup of the config file before writing. */
function backupConfig(configPath: string): void {
  if (!fs.existsSync(configPath)) return;
  rotateConfigBackups(configPath);
  try {
    fs.copyFileSync(configPath, `${configPath}.bak`);
    // Harden permissions (owner-only)
    fs.chmodSync(`${configPath}.bak`, 0o600);
  } catch {
    /* best effort */
  }
}

/** Try to recover config from .bak files when nanoclaw.json is corrupt. */
function recoverFromBackup(configPath: string): Partial<NanoclawConfig> | null {
  const candidates = [
    `${configPath}.bak`,
    ...Array.from(
      { length: MAX_BACKUP_RING },
      (_, i) => `${configPath}.bak.${i + 1}`,
    ),
  ];
  for (const bakPath of candidates) {
    try {
      if (!fs.existsSync(bakPath)) continue;
      const raw = fs.readFileSync(bakPath, 'utf-8');
      const parsed = JSON.parse(raw);
      logger.info({ bakPath }, 'Recovered config from backup');
      // Restore the main config file from backup
      fs.copyFileSync(bakPath, configPath);
      return parsed;
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Save config back to nanoclaw.json (for CLI commands like chat add).
 */
export function saveConfig(config: NanoclawConfig): void {
  // Strip secrets before saving — they stay in .env
  const toSave = JSON.parse(JSON.stringify(config));
  // Strip top-level channel secrets
  // Replace secrets with ${ENV_VAR} references (explicit, visible in json)
  if (
    toSave.channels?.telegram?.botToken &&
    !toSave.channels.telegram.botToken.startsWith('${')
  ) {
    toSave.channels.telegram.botToken = '${TELEGRAM_BOT_TOKEN}';
  }
  if (toSave.channels?.teams) {
    if (
      toSave.channels.teams.appPassword &&
      !toSave.channels.teams.appPassword.startsWith('${')
    ) {
      toSave.channels.teams.appPassword = '${MSTEAMS_APP_PASSWORD}';
    }
    delete toSave.channels.teams.certThumbprint;
    delete toSave.channels.teams.certPrivateKeyPath;
    // tenantId lives in accounts.default, not root level (v2→v3 migration)
    delete toSave.channels.teams.tenantId;
  }
  // Per-account secrets → ${ENV_VAR} references
  for (const ch of ['telegram', 'teams'] as const) {
    const accounts = toSave.channels?.[ch]?.accounts;
    if (accounts && typeof accounts === 'object') {
      for (const [accId, acc] of Object.entries(accounts) as any[]) {
        if (
          ch === 'telegram' &&
          acc.botToken &&
          !acc.botToken.startsWith('${')
        ) {
          const envKey =
            accId === 'default'
              ? 'TELEGRAM_BOT_TOKEN'
              : `TELEGRAM_BOT_TOKEN_${accId.toUpperCase()}`;
          acc.botToken = `\${${envKey}}`;
        }
        if (
          ch === 'teams' &&
          acc.appPassword &&
          !acc.appPassword.startsWith('${')
        ) {
          const envKey =
            accId === 'default'
              ? 'MSTEAMS_APP_PASSWORD'
              : `MSTEAMS_APP_PASSWORD_${accId.toUpperCase()}`;
          acc.appPassword = `\${${envKey}}`;
        }
        delete acc.certThumbprint;
        delete acc.certPrivateKeyPath;
      }
    }
  }

  // Distribute chats into channels.<name>.chats
  distributeChatsToChannels(toSave, toSave.chats || {});
  // Backup before writing
  backupConfig(paths.config);
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

// ─── Secret Migration ────────────────────────────────────────────────────────

/**
 * One-time migration: move plaintext secrets from nanoclaw.json to .env.
 * After moving, saves a clean nanoclaw.json without secrets.
 */
function migrateSecretsToEnv(config: any): void {
  const secrets: Record<string, string> = {};
  let found = false;

  // Check top-level channel secrets (skip ${ENV_VAR} references)
  if (
    config.channels?.telegram?.botToken &&
    !config.channels.telegram.botToken.startsWith('${')
  ) {
    secrets.TELEGRAM_BOT_TOKEN = config.channels.telegram.botToken;
    found = true;
  }
  if (
    config.channels?.teams?.appPassword &&
    !config.channels.teams.appPassword.startsWith('${')
  ) {
    secrets.MSTEAMS_APP_PASSWORD = config.channels.teams.appPassword;
    found = true;
  }
  // Note: appId is NOT a secret — it's a public Azure App Registration ID.
  // It stays in nanoclaw.json, not in .env.
  if (
    config.channels?.teams?.tenantId &&
    !config.channels.teams.tenantId.startsWith('${')
  ) {
    secrets.MSTEAMS_TENANT_ID = config.channels.teams.tenantId;
    found = true;
  }

  // Check per-account secrets (skip ${ENV_VAR} references)
  for (const [accId, acc] of Object.entries(
    config.channels?.telegram?.accounts || {},
  ) as any[]) {
    if (acc.botToken && !acc.botToken.startsWith('${')) {
      const key =
        accId === 'default'
          ? 'TELEGRAM_BOT_TOKEN'
          : `TELEGRAM_BOT_TOKEN_${accId.toUpperCase()}`;
      secrets[key] = acc.botToken;
      found = true;
    }
  }
  for (const [accId, acc] of Object.entries(
    config.channels?.teams?.accounts || {},
  ) as any[]) {
    if (acc.appPassword && !acc.appPassword.startsWith('${')) {
      const key =
        accId === 'default'
          ? 'MSTEAMS_APP_PASSWORD'
          : `MSTEAMS_APP_PASSWORD_${accId.toUpperCase()}`;
      secrets[key] = acc.appPassword;
      found = true;
    }
  }

  if (!found) return;

  // Append to .env
  const envPath = paths.config.replace(/nanoclaw.json$/, '.env');
  let envContent = '';
  try {
    envContent = fs.readFileSync(envPath, 'utf-8');
  } catch {
    /* no .env yet */
  }

  const lines: string[] = [];
  for (const [k, v] of Object.entries(secrets)) {
    // Only add if not already in .env
    if (!envContent.includes(`${k}=`)) {
      lines.push(`${k}=${v}`);
    }
  }

  if (lines.length > 0) {
    const append =
      '\n# Migrated from nanoclaw.json\n' + lines.join('\n') + '\n';
    fs.appendFileSync(envPath, append, { mode: 0o600 });
    logger.info(
      `Migrated ${lines.length} secret(s) from nanoclaw.json to .env`,
    );

    // Save clean config (saveConfig strips secrets)
    saveConfig(config);
    logger.info('Stripped secrets from nanoclaw.json');
  }
}
