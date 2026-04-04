/**
 * NanoClaw GHC Extensions — non-invasive overlay on upstream config.
 *
 * All GHC-specific and multi-agent logic lives here.
 * config.ts stays upstream-compatible (re-exports from config-loader).
 */
import path from 'path';
import fs from 'fs';
import { CONTAINER_IMAGE } from './config.js';
import { resolveWorkspace } from './workspace.js';
import {
  loadConfig,
  resolveAgent,
  AgentConfig,
  NanoclawConfig,
} from './config-loader.js';

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
  } catch {
    /* ignore */
  }

  return undefined;
}

// ─── Container provider configuration ────────────────────────────────────────────

/**
 * Build provider-specific environment variable args for `docker run`.
 * GHC: injects COPILOT_GITHUB_TOKEN, COPILOT_MODEL, COPILOT_THINK_LEVEL.
 * CC:  injects ANTHROPIC_BASE_URL and auth placeholder.
 */
export function buildProviderEnvArgs(
  chatJid?: string,
  opts?: { credentialProxyPort?: number; hostGateway?: string },
): string[] {
  const agent = chatJid ? resolveAgentForChat(chatJid) : undefined;
  const agentIsGHC = agent ? isAgentGHC(agent) : IS_GHC_PROVIDER;
  const args: string[] = [];

  if (agentIsGHC) {
    const ghToken = resolveGithubToken();
    if (ghToken) {
      args.push('-e', `COPILOT_GITHUB_TOKEN=${ghToken}`);
    }
    const model = agent
      ? getAgentModelName(agent)
      : getModelName() || undefined;
    if (model) {
      args.push('-e', `COPILOT_MODEL=${model}`);
    }
    const config = loadConfig();
    const thinkLevel = config.agents?.defaults?.thinkLevel;
    if (thinkLevel) {
      args.push('-e', `COPILOT_THINK_LEVEL=${thinkLevel}`);
    }
    // Enable GitHub MCP server (web_search, issues, PRs) — default true for GHC
    const agentConfig = agent || config.agents?.defaults;
    if (agentConfig?.githubMcp !== false) {
      args.push('-e', 'NANOCLAW_GITHUB_MCP=1');
    }
  } else {
    // CC mode: credential proxy
    const gateway = opts?.hostGateway || 'host-gateway';
    const port = opts?.credentialProxyPort || 18080;
    args.push('-e', `ANTHROPIC_BASE_URL=http://${gateway}:${port}`);
    const authMode = process.env.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
    if (authMode === 'api-key') {
      args.push('-e', 'ANTHROPIC_API_KEY=placeholder');
    } else {
      args.push('-e', 'CLAUDE_CODE_OAUTH_TOKEN=placeholder');
    }
  }
  return args;
}

export interface VolumeMount {
  hostPath: string;
  containerPath: string;
  readonly: boolean;
}

/**
 * Build GHC-specific extra volume mounts (skills, mcp.json).
 * Returns empty array for CC provider.
 */
export function buildProviderMounts(chatJid?: string): VolumeMount[] {
  const agent = chatJid ? resolveAgentForChat(chatJid) : undefined;
  const agentIsGHC = agent ? isAgentGHC(agent) : IS_GHC_PROVIDER;
  if (!agentIsGHC) return [];

  const ws = resolveWorkspace();
  const mounts: VolumeMount[] = [];

  // User skills directory
  const skillsDir = path.join(ws, 'skills');
  if (fs.existsSync(skillsDir)) {
    mounts.push({
      hostPath: skillsDir,
      containerPath: '/workspace/skills',
      readonly: true,
    });
  }
  // MCP config
  const mcpConfig = path.join(ws, 'mcp.json');
  if (fs.existsSync(mcpConfig)) {
    mounts.push({
      hostPath: mcpConfig,
      containerPath: '/workspace/mcp.json',
      readonly: true,
    });
  }
  return mounts;
}

/**
 * Resolve the session directory name for a chat.
 * GHC uses .copilot/, CC uses .claude/.
 */
export function resolveSessionDir(chatJid?: string): string {
  const agent = chatJid ? resolveAgentForChat(chatJid) : undefined;
  return agent ? getAgentSessionDir(agent) : PROVIDER_SESSION_DIR;
}

/**
 * Resolve the container image for a chat.
 */
export function resolveContainerImage(chatJid?: string): string {
  const agent = chatJid ? resolveAgentForChat(chatJid) : undefined;
  return agent ? getAgentImage(agent) : GHC_CONTAINER_IMAGE;
}

/**
 * Resolve the agent-runner directory name.
 */
export function resolveRunnerDir(chatJid?: string): string {
  const agent = chatJid ? resolveAgentForChat(chatJid) : undefined;
  const agentIsGHC = agent ? isAgentGHC(agent) : IS_GHC_PROVIDER;
  return agentIsGHC ? 'agent-runner-ghc' : 'agent-runner';
}

// --- Runner selection (host vs container) ---
// Re-export a unified runner function so callers (index.ts, task-scheduler.ts)
// don't need to import both runners and duplicate the mode check.

import type { ChildProcess } from 'child_process';
import type { ContainerOutput, ContainerInput } from './container-runner.js';
import { runContainerAgent } from './container-runner.js';

let _hostRunnerModule: typeof import('./host-runner.js') | null = null;
async function getHostRunner() {
  if (!_hostRunnerModule) {
    _hostRunnerModule = await import('./host-runner.js');
  }
  return _hostRunnerModule;
}

type RunnerGroup = Parameters<typeof runContainerAgent>[0];
type OnProcess = (proc: ChildProcess, name: string) => void;
type OnOutput = (output: ContainerOutput) => Promise<void>;

export async function runAgentForChat(
  chatJid: string,
  group: RunnerGroup,
  input: ContainerInput,
  onProcess: OnProcess,
  onOutput?: OnOutput,
): Promise<ContainerOutput> {
  const agent = resolveAgentForChat(chatJid);
  // Enrich input with agent-specific overrides
  const enrichedInput = {
    ...input,
    assistantName: agent.name || input.assistantName,
    model: getAgentModelName(agent) || input.model,
  };
  if (agent.mode === 'host') {
    const { runHostAgent } = await getHostRunner();
    return runHostAgent(group, enrichedInput, onProcess, onOutput);
  }
  return runContainerAgent(group, enrichedInput, onProcess, onOutput);
}
