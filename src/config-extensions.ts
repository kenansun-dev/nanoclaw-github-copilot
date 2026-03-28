/**
 * NanoClaw GHC Extensions — non-invasive overlay on upstream config.
 *
 * All GHC-specific and multi-agent logic lives here.
 * config.ts stays upstream-compatible (re-exports from config-loader).
 */
import path from 'path';
import fs from 'fs';
import { CONTAINER_IMAGE } from './config.js';
import { loadConfig, resolveAgent, AgentConfig, NanoclawConfig } from './config-loader.js';

// ─── Provider detection ──────────────────────────────────────────────────────

export function getProvider(model?: string): string {
  const config = loadConfig();
  const m = model || config.agents?.defaults?.model || '';
  const slash = m.indexOf('/');
  return slash > 0 ? m.substring(0, slash) : 'anthropic';
}

export function getModelName(model?: string): string {
  const config = loadConfig();
  const m = model || config.agents?.defaults?.model || '';
  const slash = m.indexOf('/');
  return slash > 0 ? m.substring(slash + 1) : m;
}

export function isGHCProvider(model?: string): boolean {
  return getProvider(model) === 'github-copilot';
}

// Module-level constants (from default agent)
const _provider = getProvider();
export const IS_GHC_PROVIDER = _provider === 'github-copilot';
export const PROVIDER_SESSION_DIR = IS_GHC_PROVIDER ? '.copilot' : '.claude';
export const GHC_CONTAINER_IMAGE = IS_GHC_PROVIDER
  ? 'nanoclaw-agent-ghc:latest'
  : CONTAINER_IMAGE;

// ─── Agent resolution ────────────────────────────────────────────────────────

export function resolveAgentForChat(chatJid: string): AgentConfig {
  const config = loadConfig();
  const chat = config.chats[chatJid];
  return resolveAgent(config, chat?.agentId);
}

export function isAgentGHC(agent: AgentConfig): boolean {
  return isGHCProvider(agent.model);
}

export function getAgentSessionDir(agent: AgentConfig): string {
  return isAgentGHC(agent) ? '.copilot' : '.claude';
}

export function getAgentImage(agent: AgentConfig): string {
  return isAgentGHC(agent) ? 'nanoclaw-agent-ghc:latest' : CONTAINER_IMAGE;
}

export function getAgentModelName(agent: AgentConfig): string {
  const model = agent.model || '';
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(slash + 1) : model;
}

export function getAgentProvider(agent: AgentConfig): string {
  const model = agent.model || '';
  const slash = model.indexOf('/');
  return slash > 0 ? model.substring(0, slash) : 'anthropic';
}

// ─── Token resolution ────────────────────────────────────────────────────────

export function resolveGithubToken(): string | undefined {
  const envToken =
    process.env.COPILOT_GITHUB_TOKEN ||
    process.env.GH_TOKEN ||
    process.env.GITHUB_TOKEN;
  if (envToken) return envToken;

  try {
    const profilePath = path.join(
      process.env.HOME || '/root',
      '.openclaw/agents/main/agent/auth-profiles.json',
    );
    if (fs.existsSync(profilePath)) {
      const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
      for (const [, profile] of Object.entries(profiles.profiles || {})) {
        const p = profile as { provider?: string; token?: string };
        if (p.provider === 'github-copilot' && p.token) return p.token;
      }
    }
  } catch { /* ignore */ }

  return undefined;
}
