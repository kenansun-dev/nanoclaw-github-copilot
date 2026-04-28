/**
 * GitHub Copilot provider for v2 agent-runner.
 *
 * Wraps `@github/copilot-sdk` (CopilotClient) into the v2 AgentProvider
 * interface so the v2 poll-loop can drive GHC sessions the same way it
 * drives Claude SDK sessions.
 *
 * STATUS: C-step2 — SDK glue ported. Implements query() with full event
 * translation + 2-layer session recovery. Defers plugin-agents loading +
 * MCP server discovery + github-mcp-server config to C-step3 (those are
 * additive and don't gate baseline functionality).
 *
 * Design vs Claude provider:
 *   Claude SDK is async-iterable (for await message of sdkQuery(...)).
 *   GHC SDK is emitter-based (session.on('assistant.message', ...)).
 *   So we bridge: emitter callbacks push into an internal queue, and
 *   translateEvents() pulls from the queue as an AsyncGenerator.
 *
 * Recovery (preserved from container/agent-runner-ghc/src/index.ts):
 *   Layer 1: always call resumeSession() on every query() call. Even a
 *            "fresh" session might have been evicted between turns.
 *   Layer 2: catch `Session not found` from session.send() mid-turn,
 *            recreate session and retry once.
 */

import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';

import { CopilotClient, approveAll } from '@github/copilot-sdk';

import { loadPluginAgents } from './load-plugin-agents.js';
import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[copilot-provider] ${msg}`);
}

function isSessionNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /session\s*not\s*found/i.test(msg);
}

function resolveGithubToken(env: Record<string, string | undefined>): string | undefined {
  return (
    env.NANOCLAW_GITHUB_TOKEN ||
    env.GITHUB_COPILOT_TOKEN ||
    env.GH_TOKEN ||
    env.GITHUB_TOKEN
  );
}

function resolveModel(env: Record<string, string | undefined>): string {
  let model = env.COPILOT_MODEL || 'claude-sonnet-4';
  if (model.includes('/')) model = model.split('/').slice(1).join('/');
  return model;
}

/** Resolve plugin dirs from `NANOCLAW_PLUGIN_DIRS` (PATH-style separator). */
function resolvePluginDirs(env: Record<string, string | undefined>): string[] {
  const raw = env.NANOCLAW_PLUGIN_DIRS;
  if (!raw) return [];
  return raw
    .split(path.delimiter)
    .filter((d) => d && fs.existsSync(d));
}

/**
 * Load extra MCP servers from on-disk JSON config (legacy fork pattern).
 * Path: `$NANOCLAW_MCP_CONFIG` or `/workspace/mcp.json`. Each entry must
 * declare `tools` (defaults to `['*']`); `auth` is stripped because the SDK
 * does not recognize the fork-internal field.
 */
function loadDiskMcpServers(
  env: Record<string, string | undefined>,
): Record<string, any> {
  const cfgPath = env.NANOCLAW_MCP_CONFIG || '/workspace/mcp.json';
  if (!fs.existsSync(cfgPath)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(cfgPath, 'utf-8'));
    const servers = parsed.mcpServers || parsed;
    for (const [, cfg] of Object.entries(servers) as Array<[string, any]>) {
      if (!cfg.tools) cfg.tools = ['*'];
      delete cfg.auth;
    }
    log(`Loaded ${Object.keys(servers).length} MCP server(s) from ${cfgPath}`);
    return servers;
  } catch (err) {
    log(`Failed to parse ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`);
    return {};
  }
}

/**
 * GitHub MCP HTTP server config — only when `NANOCLAW_GITHUB_MCP=1` and a
 * github token is available. Mirrors the GHC fork mapping so existing skills
 * keep working.
 */
function githubMcpServerConfig(
  env: Record<string, string | undefined>,
  githubToken: string | undefined,
): Record<string, any> {
  if (env.NANOCLAW_GITHUB_MCP !== '1' || !githubToken) return {};
  return {
    'github-mcp-server': {
      type: 'http' as const,
      url: 'https://api.githubcopilot.com/mcp',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        'X-MCP-Toolsets':
          'repos,issues,users,pull_requests,code_security,secret_protection,actions,web_search',
        'X-MCP-Host': 'copilot-cli',
        'X-Initiator': 'agent',
      },
      tools: ['*'],
    },
  };
}

class CopilotAgentProvider implements AgentProvider {
  /**
   * GHC SDK does not expose slash-command parsing; v2 poll-loop should
   * format slash commands as plain chat messages (same as Claude provider).
   */
  readonly supportsNativeSlashCommands = false;

  private readonly env: Record<string, string | undefined>;
  private readonly client: CopilotClient;

  constructor(private readonly options: ProviderOptions) {
    this.env = options.env ?? process.env;
    const githubToken = resolveGithubToken(this.env);
    const pluginDirs = resolvePluginDirs(this.env);
    const pluginCliArgs: string[] = [];
    for (const d of pluginDirs) pluginCliArgs.push('--plugin-dir', d);

    const clientOpts: any = {};
    if (githubToken) clientOpts.githubToken = githubToken;
    if (pluginCliArgs.length > 0) clientOpts.cliArgs = pluginCliArgs;
    this.client = new CopilotClient(clientOpts);
  }

  query(input: QueryInput): AgentQuery {
    // Workaround for GHC SDK 0.2.2 server-mode --plugin-dir gap: load
    // plugin agents ourselves and pass via SessionConfig.customAgents.
    const pluginDirs = resolvePluginDirs(this.env);
    const customAgents = loadPluginAgents(pluginDirs, {
      onWarn: (msg) => log(msg),
    });
    if (customAgents.length > 0) {
      log(
        `Loaded ${customAgents.length} custom agent(s): ${customAgents
          .map((a) => a.name)
          .join(', ')}`,
      );
    }
    return runCopilotQuery(this.client, this.env, this.options, input, customAgents);
  }

  isSessionInvalid(err: unknown): boolean {
    return isSessionNotFoundError(err);
  }
}

/**
 * Execute a single GHC query: create/resume session, wire events, return
 * the AgentQuery handle that v2 poll-loop drives.
 *
 * Lifecycle:
 *   1. Build sessionConfig from env + options.
 *   2. resume (if continuation) or create session.
 *   3. Bridge session.on(...) → event queue.
 *   4. session.send({prompt}); on Session-not-found → recreate + retry once.
 *   5. session.idle → emit {type:'result'} → done.
 *
 * push(msg) during an active turn: re-call session.send (GHC SDK serializes).
 * end() / abort(): mark stream done, stop accepting further pushes.
 */
function runCopilotQuery(
  client: CopilotClient,
  env: Record<string, string | undefined>,
  options: ProviderOptions,
  input: QueryInput,
  customAgents: ReadonlyArray<{
    name: string;
    displayName?: string;
    description?: string;
    tools?: string[];
    prompt: string;
  }> = [],
): AgentQuery {
  const model = resolveModel(env);
  const thinkLevel = env.COPILOT_THINK_LEVEL || undefined;
  const workingDirectory = env.NANOCLAW_WORK_DIR || input.cwd || '/workspace/group';
  const instructions = input.systemContext?.instructions;

  let sessionId: string | undefined = input.continuation;
  let session: any = null;
  let aborted = false;
  let initEmitted = false;
  let lastContent: string | null = null;

  // Emitter→queue bridge. Callbacks register with the queue; consumer
  // pulls via an async iterator.
  const queue: ProviderEvent[] = [];
  const waiters: Array<(v: ProviderEvent | null) => void> = [];
  let streamClosed = false;

  function push(event: ProviderEvent): void {
    if (streamClosed) return;
    const w = waiters.shift();
    if (w) w(event);
    else queue.push(event);
  }

  function close(): void {
    if (streamClosed) return;
    streamClosed = true;
    while (waiters.length > 0) {
      const w = waiters.shift()!;
      w(null);
    }
  }

  async function next(): Promise<ProviderEvent | null> {
    if (queue.length > 0) return queue.shift()!;
    if (streamClosed) return null;
    return new Promise((resolve) => waiters.push(resolve));
  }

  function buildSessionConfig() {
    const mcpServers: Record<string, any> = {};
    if (options.mcpServers) {
      for (const [name, cfg] of Object.entries(options.mcpServers)) {
        mcpServers[name] = {
          type: 'local' as const,
          command: cfg.command,
          args: cfg.args,
          env: cfg.env,
          tools: ['*'],
        };
      }
    }

    // Layer in github-mcp HTTP + disk mcp.json (additive, env-gated).
    Object.assign(
      mcpServers,
      githubMcpServerConfig(env, resolveGithubToken(env)),
      loadDiskMcpServers(env),
    );

    return {
      model,
      ...(thinkLevel ? { reasoningEffort: thinkLevel as any } : {}),
      enableConfigDiscovery: env.NANOCLAW_MCP_DISCOVERY === '1',
      ...(customAgents.length > 0
        ? {
            customAgents: customAgents.map((a) => ({
              name: a.name,
              ...(a.displayName ? { displayName: a.displayName } : {}),
              ...(a.description ? { description: a.description } : {}),
              ...(a.tools ? { tools: a.tools } : {}),
              prompt: a.prompt,
            })),
          }
        : {}),
      systemMessage: instructions
        ? { mode: 'replace' as const, content: instructions }
        : undefined,
      workingDirectory,
      onPermissionRequest: approveAll,
      streaming: true,
      onEvent: (event: any) => {
        if (event.type === 'session.warning') {
          push({ type: 'progress', message: `${event.data?.warningType}: ${event.data?.message}` });
        } else if (event.type === 'session.error') {
          push({ type: 'progress', message: `${event.data?.errorType}: ${event.data?.message}` });
        }
      },
      mcpServers,
      ...(options.additionalDirectories && options.additionalDirectories.length > 0
        ? { skillDirectories: options.additionalDirectories }
        : {}),
    };
  }

  function wireSessionListeners(): () => void {
    const cleanups: Array<() => void> = [];

    cleanups.push(
      session.on('assistant.message_delta' as any, () => {
        push({ type: 'activity' });
      }),
    );

    cleanups.push(
      session.on('assistant.reasoning_delta' as any, () => {
        push({ type: 'activity' });
      }),
    );

    cleanups.push(
      session.on('assistant.message' as any, (event: any) => {
        push({ type: 'activity' });
        if (event.data?.content) {
          lastContent = event.data.content;
        }
      }),
    );

    cleanups.push(
      session.on('session.idle' as any, () => {
        push({ type: 'result', text: lastContent });
        // GHC's idle = turn done. Reset lastContent for next push().
        lastContent = null;
      }),
    );

    cleanups.push(
      session.on('session.error' as any, (event: any) => {
        push({
          type: 'error',
          message: event.data?.message || 'Session error',
          retryable: false,
          classification: event.data?.errorType,
        });
        close();
      }),
    );

    return () => {
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* ignore */
        }
      }
    };
  }

  let cleanupListeners: (() => void) | null = null;

  async function ensureSession(): Promise<void> {
    const sessionConfig = buildSessionConfig();
    if (sessionId) {
      try {
        session = await client.resumeSession(sessionId, sessionConfig);
        try {
          await session.rpc.mcp.reload();
        } catch {
          /* ignore — MCP reload is best-effort */
        }
        log(`Resumed session: ${sessionId}`);
      } catch (err) {
        log(`Resume failed (${err instanceof Error ? err.message : String(err)}), creating new`);
        session = await client.createSession({ ...sessionConfig, sessionId: randomUUID() });
        sessionId = session.sessionId;
        log(`New session: ${sessionId}`);
      }
    } else {
      session = await client.createSession({ ...sessionConfig, sessionId: randomUUID() });
      sessionId = session.sessionId;
      log(`Session created: ${sessionId}`);
    }

    if (!initEmitted && sessionId) {
      push({ type: 'init', continuation: sessionId });
      initEmitted = true;
    }

    if (cleanupListeners) cleanupListeners();
    cleanupListeners = wireSessionListeners();
  }

  // Drive a single send with layer-2 recovery.
  async function sendOnce(prompt: string): Promise<void> {
    try {
      await session.send({ prompt });
    } catch (err) {
      if (isSessionNotFoundError(err) && sessionId) {
        log(`session.send hit Session not found mid-turn, recovering`);
        if (cleanupListeners) {
          cleanupListeners();
          cleanupListeners = null;
        }
        session = null;
        await ensureSession();
        await session.send({ prompt });
        return;
      }
      throw err;
    }
  }

  // Kick off the initial send.
  (async () => {
    try {
      await ensureSession();
      await sendOnce(input.prompt);
    } catch (err) {
      if (aborted) return;
      push({
        type: 'error',
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      });
      close();
    }
  })();

  async function* events(): AsyncGenerator<ProviderEvent> {
    while (true) {
      const ev = await next();
      if (ev === null) return;
      yield ev;
    }
  }

  return {
    push: (msg: string) => {
      if (aborted || streamClosed) return;
      sendOnce(msg).catch((err) => {
        push({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          retryable: false,
        });
        close();
      });
    },
    end: () => {
      // GHC has no explicit "end of input"; close stream after current turn
      // resolves via session.idle. Force-close if poll-loop signals end.
      close();
    },
    events: events(),
    abort: () => {
      aborted = true;
      if (cleanupListeners) cleanupListeners();
      close();
    },
  };
}

registerProvider('copilot', (options: ProviderOptions) => new CopilotAgentProvider(options));
registerProvider(
  'github-copilot',
  (options: ProviderOptions) => new CopilotAgentProvider(options),
);
