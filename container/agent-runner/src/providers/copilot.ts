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

import { randomUUID } from 'crypto';

import { CopilotClient, approveAll } from '@github/copilot-sdk';

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
    const clientOpts: any = {};
    if (githubToken) clientOpts.githubToken = githubToken;
    this.client = new CopilotClient(clientOpts);
  }

  query(input: QueryInput): AgentQuery {
    return runCopilotQuery(this.client, this.env, this.options, input);
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

    return {
      model,
      ...(thinkLevel ? { reasoningEffort: thinkLevel as any } : {}),
      enableConfigDiscovery: env.NANOCLAW_MCP_DISCOVERY === '1',
      systemMessage: instructions,
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
