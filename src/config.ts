/**
 * Config module for nanoclaw.
 *
 * Reads from nanoclaw.json (via config-loader) with env var overrides.
 * All hardcoded defaults are in config-loader.ts.
 */

import os from 'os';
import path from 'path';

import { fileURLToPath } from 'url';
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

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

// ─── Paths ───────────────────────────────────────────────────────────────────

// Package root — where nanoclaw is installed (for bundled assets like agent-runner)
export const PACKAGE_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const HOME_DIR = process.env.HOME || os.homedir();

// Security allowlists — in workspace
export const MOUNT_ALLOWLIST_PATH = workspacePath('mount-allowlist.json');
export const SENDER_ALLOWLIST_PATH = workspacePath('sender-allowlist.json');

// Data directories — use workspace (set NANOCLAW_WORKSPACE env to override)
export const STORE_DIR = path.resolve(resolveWorkspace(), 'store');
export const GROUPS_DIR = path.resolve(resolveWorkspace(), 'groups');
export const DATA_DIR = path.resolve(resolveWorkspace(), 'data');

// ─── Container / Sandbox ─────────────────────────────────────────────────────

// Container image — extensions may override via config-extensions.ts
export const CONTAINER_IMAGE = _config.sandbox.image;

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

// --- Upstream compat exports ---
export const ONECLI_URL = process.env.ONECLI_URL || 'http://localhost:10254';

export const MAX_MESSAGES_PER_PROMPT = Math.max(
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
  1,
);
export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const CONTAINER_HOST_GATEWAY = 'host.docker.internal';
export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);
