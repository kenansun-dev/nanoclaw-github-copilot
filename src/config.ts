/**
 * Config module for nanoclaw.
 *
 * Reads from nanoclaw.json (via config-loader) with env var overrides.
 * All hardcoded defaults are in config-loader.ts.
 */

import os from 'os';
import path from 'path';

import { loadConfig, NanoclawConfig } from './config-loader.js';
import { workspacePath, resolveWorkspace } from './workspace.js';

// Load config once at module init. Can be refreshed by calling reloadConfig().
let _config: NanoclawConfig = loadConfig();

export function reloadConfig(): void {
  _config = loadConfig();
}

export function getConfig(): NanoclawConfig {
  return _config;
}

// ─── Derived values (backwards compatible exports) ───────────────────────────

export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const IPC_POLL_INTERVAL = 1000;

// These are getters so they reflect config changes
export function getAssistantName(): string {
  return _config.agents.defaults.name;
}

// Keep backward compat as constants (evaluated at import time)
export const ASSISTANT_NAME = _config.agents.defaults.name;
export const ASSISTANT_HAS_OWN_NUMBER = _config.agents.defaults.hasOwnNumber;

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// ─── Paths ───────────────────────────────────────────────────────────────────

const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Security allowlists — in workspace
export const MOUNT_ALLOWLIST_PATH = workspacePath('mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = workspacePath('sender-allowlist.json');

// Data directories — in project root (for now)
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

// ─── Container / Sandbox ─────────────────────────────────────────────────────

// Derive provider from model string: "github-copilot/claude-sonnet-4" -> "github-copilot"
export function getProvider(): string {
  const model = _config.agents?.defaults?.model || '';
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(0, slash) : 'anthropic';
}
export function getModelName(): string {
  const model = _config.agents?.defaults?.model || '';
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(slash + 1) : model;
}
const _provider = getProvider();
export const IS_GHC_PROVIDER = _provider === 'github-copilot';
export const CONTAINER_IMAGE = IS_GHC_PROVIDER
  ? 'nanoclaw-agent-ghc:latest'
  : _config.sandbox.image;
export const PROVIDER_SESSION_DIR = IS_GHC_PROVIDER ? '.copilot' : '.claude';

export const CONTAINER_TIMEOUT = _config.sandbox.timeout;
export const CONTAINER_MAX_OUTPUT_SIZE = _config.sandbox.maxOutputSize;
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  _config.sandbox.maxConcurrent,
);
export const IDLE_TIMEOUT = _config.sandbox.idleTimeout;

// ─── Credential Proxy ────────────────────────────────────────────────────────

export const CREDENTIAL_PROXY_PORT = _config.credentialProxy.port;

// ─── Timezone ────────────────────────────────────────────────────────────────

export const TIMEZONE = _config.timezone;
