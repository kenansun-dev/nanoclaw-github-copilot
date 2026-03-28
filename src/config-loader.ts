/**
 * Config loader for nanoclaw.
 * Reads nanoclaw.json from workspace, merges with defaults, reads .env for secrets.
 */

import fs from 'fs';
import { logger } from './logger.js';
import { paths, workspacePath } from './workspace.js';

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NanoclawConfig {
  assistant: {
    name: string;
    triggerWord: string;
    hasOwnNumber: boolean;
  };
  providers: {
    'github-copilot': {
      enabled: boolean;
      model: string;
      auth: 'openclaw-profile' | 'env' | 'cli';
    };
    [key: string]: { enabled: boolean; [k: string]: unknown };
  };
  channels: {
    telegram: {
      enabled: boolean;
      botToken?: string;
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
    ghcImage: string;
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
    }
  >;
  pairing: {
    mode: 'open' | 'prompt' | 'allowlist' | 'disabled';
    notifyChat?: string;
  };
  credentialProxy: {
    port: number;
  };
  logLevel: string;
  timezone: string;
}

// ─── Defaults ────────────────────────────────────────────────────────────────

const DEFAULTS: NanoclawConfig = {
  assistant: {
    name: 'Andy',
    triggerWord: '@Andy',
    hasOwnNumber: false,
  },
  providers: {
    'github-copilot': {
      enabled: true,
      model: 'claude-sonnet-4',
      auth: 'openclaw-profile',
    },
  },
  channels: {
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
    ghcImage: 'nanoclaw-agent-ghc:latest',
    timeout: 1800000,
    maxOutputSize: 10485760,
    maxConcurrent: 5,
    idleTimeout: -1,
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

  fs.writeFileSync(paths.config, JSON.stringify(toSave, null, 2) + '\n');
}
