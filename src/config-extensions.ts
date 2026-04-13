/**
 * NanoClaw GHC Extensions — non-invasive overlay on upstream config.
 *
 * All GHC-specific and multi-agent logic lives here.
 * config.ts stays upstream-compatible (re-exports from config-loader).
 */
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync as execSyncFn } from 'child_process';
import { CONTAINER_IMAGE } from './config.js';
import { resolveWorkspace } from './workspace.js';
import { resolveAgentIdFromBindings } from './config-loader.js';
import {
  loadConfig,
  resolveAgent,
  AgentConfig,
  NanoclawConfig,
} from './config-loader.js';

// ─── Provider detection ──────────────────────────────────────────────────────

export function getProvider(model?: string): string {
  const config = loadConfig();
  const agent = config.agents?.defaults;
  if (model) {
    // Explicit model string: parse it directly
    const slash = model.indexOf('/');
    return slash > 0 ? model.substring(0, slash) : 'anthropic';
  }
  // No model arg: check config provider field, then parse config model
  if (agent?.provider) return agent.provider;
  const m = agent?.model || '';
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
  // Check bindings first, then legacy chatConfig.agentId
  const agentId =
    resolveAgentIdFromBindings(config, chatJid, chat) || chat?.agentId;
  return resolveAgent(config, agentId);
}

export function isAgentGHC(agent: AgentConfig): boolean {
  // Check explicit provider field first, then parse model string
  if (agent.provider) return agent.provider === 'github-copilot';
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
  // Check explicit provider field first
  if (agent.provider) return agent.provider;
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

  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();

  // Check ~/.copilot/ (GHC CLI's own auth storage from 'copilot auth login')
  // Also check ~/.config/github-copilot/ (some CLI versions use this)
  // NOTE: copilot CLI primarily stores tokens in the OS credential manager
  // (Windows Credential Manager / macOS Keychain / Linux keyring).
  // File-based storage is only used as fallback.
  const copilotAuthDirs = [
    path.join(home, '.copilot'),
    path.join(home, '.config', 'github-copilot'),
    // NOTE: Do NOT scan AppData\Local\github-copilot or AppData\Roaming\github-copilot
    // — those contain VS Code/VS Copilot extension tokens which are incompatible with CLI SDK
  ];
  for (const copilotDir of copilotAuthDirs) {
    try {
      if (!fs.existsSync(copilotDir)) continue;
      // Try config.json — copilot CLI stores tokens here
      const configFile = path.join(copilotDir, 'config.json');
      if (fs.existsSync(configFile)) {
        const config = JSON.parse(fs.readFileSync(configFile, 'utf-8'));
        // copilot_tokens: { "https://github.com:user": "gho_xxx" }
        if (
          config.copilot_tokens &&
          typeof config.copilot_tokens === 'object'
        ) {
          for (const [, token] of Object.entries(config.copilot_tokens)) {
            if (typeof token === 'string' && token.length > 4) return token;
          }
        }
        if (config.oauth_token) return config.oauth_token;
        if (config.token) return config.token;
        if (config.github_token) return config.github_token;
      }
      // Try hosts.json (older CLI versions)
      const hostsFile = path.join(copilotDir, 'hosts.json');
      if (fs.existsSync(hostsFile)) {
        const hosts = JSON.parse(fs.readFileSync(hostsFile, 'utf-8'));
        for (const [, hostData] of Object.entries(hosts)) {
          const h = hostData as { oauth_token?: string; token?: string };
          if (h.oauth_token) return h.oauth_token;
          if (h.token) return h.token;
        }
      }
      // Try apps.json (newer CLI versions)
      const appsFile = path.join(copilotDir, 'apps.json');
      if (fs.existsSync(appsFile)) {
        const apps = JSON.parse(fs.readFileSync(appsFile, 'utf-8'));
        for (const [, appData] of Object.entries(apps)) {
          const a = appData as { oauth_token?: string; token?: string };
          if (a.oauth_token) return a.oauth_token;
          if (a.token) return a.token;
        }
      }
      // Try any .json file that might contain a token
      for (const file of fs.readdirSync(copilotDir)) {
        if (!file.endsWith('.json')) continue;
        if (['hosts.json', 'apps.json', 'config.json'].includes(file)) continue;
        try {
          const data = JSON.parse(
            fs.readFileSync(path.join(copilotDir, file), 'utf-8'),
          );
          if (typeof data === 'object' && data !== null) {
            for (const [, val] of Object.entries(data)) {
              const v = val as any;
              if (v?.oauth_token) return v.oauth_token;
              if (
                v?.token &&
                typeof v.token === 'string' &&
                v.token.startsWith('ghu_')
              )
                return v.token;
            }
          }
        } catch {
          /* skip unparseable files */
        }
      }
    } catch {
      /* ignore */
    }
  }

  return undefined;
}

/**
 * Check if copilot CLI reports authenticated status.
 * This detects tokens stored in OS credential manager that we can't read directly.
 */
export function isCopilotAuthenticated(): boolean {
  // Try multiple CLI commands — different copilot versions use different subcommands
  const commands = [
    'copilot auth whoami',
    'copilot auth status',
    'copilot status',
  ];
  for (const cmd of commands) {
    try {
      const output = execSyncFn(cmd, {
        encoding: 'utf-8',
        timeout: 5000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (/logged in|authenticated|signed in|username|@/i.test(output)) {
        return true;
      }
    } catch {
      // command not found or failed — try next
    }
  }
  return false;
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

  // Plugin directories — mount from 3 sources
  const pluginDirs: string[] = [];
  const pluginSources = [
    path.join(ws, 'plugins'),
    path.join(os.homedir(), '.copilot', 'plugins'),
    path.join(os.homedir(), '.claude', 'plugins'),
  ];
  for (const src of pluginSources) {
    if (fs.existsSync(src)) {
      try {
        for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            const pluginPath = path.join(src, entry.name);
            if (
              fs.existsSync(path.join(pluginPath, 'plugin.json')) ||
              fs.existsSync(
                path.join(pluginPath, '.claude-plugin', 'plugin.json'),
              )
            ) {
              pluginDirs.push(pluginPath);
              mounts.push({
                hostPath: pluginPath,
                containerPath: `/workspace/plugins/${entry.name}`,
                readonly: true,
              });
            }
          }
        }
      } catch {
        /* skip */
      }
    }
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
    agentId: agent.id || undefined,
  };
  if (agent.mode === 'host') {
    const { runHostAgent } = await getHostRunner();
    return runHostAgent(group, enrichedInput, onProcess, onOutput);
  }
  return runContainerAgent(group, enrichedInput, onProcess, onOutput);
}
