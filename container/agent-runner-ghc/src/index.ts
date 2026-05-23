import { randomUUID } from 'crypto';
/**
 * NanoClaw Agent Runner (Copilot SDK version)
 * Runs inside a container, receives config via stdin, outputs result to stdout.
 * Uses @github/copilot-sdk instead of @anthropic-ai/claude-agent-sdk.
 *
 * Input protocol:
 *   Stdin: Full ContainerInput JSON (read until EOF)
 *   IPC:   Follow-up messages written as JSON files to /workspace/ipc/input/
 *          Sentinel: /workspace/ipc/input/_close — signals session end
 *
 * Stdout protocol:
 *   Each result is wrapped in OUTPUT_START_MARKER / OUTPUT_END_MARKER pairs.
 */

import fs from 'fs';
import path from 'path';
import { CopilotClient, approveAll } from '@github/copilot-sdk';
import { fileURLToPath } from 'url';
import { isSessionNotFoundError } from './session-recovery.js';
import { loadPluginAgents } from './load-plugin-agents.js';
import { makeIpcHelpers } from './ipc-helpers.js';

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isDefaultAgent: boolean;
  /** Channel-qualified user id of the latest sender (e.g. `telegram:123`). */
  triggeringUserId?: string;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  agentId?: string;
}

/**
 * Tool-call lifecycle event surfaced to the host dispatcher. The shape
 * + mapping logic live in `./progress-envelope.ts` so unit tests can
 * import them without booting the runner (index.ts calls `main()` at
 * import time). Mirrors src/container-runner.ts `ContainerProgressEnvelope`
 * byte-for-byte.
 */
import {
  toProgressEnvelope,
  type ContainerProgressEnvelope,
} from './progress-envelope.js';

interface ContainerOutput {
  status: 'success' | 'error' | 'thinking' | 'progress';
  result: string | null;
  newSessionId?: string;
  error?: string;
  partial?: boolean;
  thinking?: string;
  progress?: ContainerProgressEnvelope;
}

const IPC_INPUT_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', reject);
  });
}

const OUTPUT_START_MARKER = '---NANOCLAW_OUTPUT_START---';
const OUTPUT_END_MARKER = '---NANOCLAW_OUTPUT_END---';

function writeOutput(output: ContainerOutput): void {
  const text = `${OUTPUT_START_MARKER}\n${JSON.stringify(output)}\n${OUTPUT_END_MARKER}\n`;
  process.stdout.write(text);
}

/**
 * Emit a single ContainerProgressEnvelope as a status='progress' output
 * marker. The host dispatcher's progress lane consumes these without
 * touching the answer/thinking lanes. Best-effort: any serialization
 * failure is logged and swallowed.
 */
function writeProgressEnvelope(progress: ContainerProgressEnvelope): void {
  try {
    writeOutput({
      status: 'progress',
      result: null,
      progress,
    });
  } catch (err) {
    log(`writeProgressEnvelope failed (non-fatal): ${(err as Error).message}`);
  }
}

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

// IPC helpers extracted to ipc-helpers.ts so unit tests import the real
// implementation instead of re-implementing the logic in the test file.
const { shouldClose, drainIpcInput, waitForIpcMessage } = makeIpcHelpers({
  inputDir: IPC_INPUT_DIR,
  closeSentinel: IPC_INPUT_CLOSE_SENTINEL,
  pollMs: IPC_POLL_MS,
  log,
});

/**
 * Archive conversation transcript before it gets too long.
 */
function archiveConversation(messages: Array<{ role: string; content: string }>, assistantName?: string): void {
  try {
    if (messages.length === 0) return;

    const conversationsDir = path.join(process.env.NANOCLAW_WORK_DIR || '/workspace/group', 'conversations');
    fs.mkdirSync(conversationsDir, { recursive: true });

    const date = new Date().toISOString().split('T')[0];
    const time = new Date();
    const name = `conversation-${time.getHours().toString().padStart(2, '0')}${time.getMinutes().toString().padStart(2, '0')}`;
    const filename = `${date}-${name}.md`;
    const filePath = path.join(conversationsDir, filename);

    const lines: string[] = [];
    lines.push(`# Conversation`);
    lines.push('');
    lines.push(
      `Archived: ${time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`,
    );
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
      const sender = msg.role === 'user' ? 'User' : assistantName || 'Assistant';
      const content = msg.content.length > 2000 ? msg.content.slice(0, 2000) + '...' : msg.content;
      lines.push(`**${sender}**: ${content}`);
      lines.push('');
    }

    fs.writeFileSync(filePath, lines.join('\n'));
    log(`Archived conversation to ${filePath}`);
  } catch (err) {
    log(`Failed to archive: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function main(): Promise<void> {
  let containerInput: ContainerInput;

  try {
    const stdinData = await readStdin();
    containerInput = JSON.parse(stdinData);
    try {
      fs.unlinkSync('/tmp/input.json');
    } catch {
      /* may not exist */
    }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`,
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Resolve IPC MCP server path.
  // Compiled mode: __dirname = dist/, mcp-tools/index.js exists locally.
  // Dev mode (tsx): __dirname = src/, .js missing → use ../dist/.
  // The 5-module barrel (mcp-tools/index.js) replaces the legacy single
  // ipc-mcp-stdio.js entrypoint. The legacy file is retained one commit
  // for rollback; cut here so smoke can validate the new path.
  const localJs = path.join(__dirname, 'mcp-tools', 'index.js');
  const distJs = path.join(__dirname, '..', 'dist', 'mcp-tools', 'index.js');
  const mcpServerPath = fs.existsSync(localJs) ? localJs : distJs;

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try {
    fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL);
  } catch {
    /* ignore */
  }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = [
      '[SCHEDULED TASK]',
      'This is an automated cron-triggered run. Strict output rules:',
      '- Output ONLY the requested content (e.g. the summary, the report, the answer).',
      '- Do NOT narrate work in progress (no "Let me check…", "Searching…", "I will now…").',
      '- Do NOT add closing acknowledgments (no "Done", "Sent", "Hope this helps", "Let me know if…").',
      '- No greetings, no sign-offs, no meta commentary about the task itself.',
      '- If the task asks for a search/lookup, run the tool silently and reply with only the result.',
      '- If you have nothing useful to report, reply with an empty string (the runner will skip it).',
      '',
      'Task instructions:',
      prompt,
    ].join('\n');
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Build dynamic identity + runtime info
  const agentName = containerInput.assistantName || 'Andy';
  const isHostMode = process.env.NANOCLAW_HOST_MODE === '1';
  // This runner is GHC-only (imports @github/copilot-sdk above), so the
  // provider is always GitHub Copilot. Earlier code parsed `model` for a
  // `provider/model` prefix and fell back to the literal string
  // 'unknown', which leaked into the system prompt as
  // "powered by unknown" whenever the agent's `model` config used a
  // short name (e.g. 'claude-sonnet-4', 'gpt-5').
  const providerLabel = 'GitHub Copilot';
  const os = await import('os');
  const runtimeLines = [
    `Your name is ${agentName}. You are a personal AI assistant powered by ${providerLabel}. When introducing yourself, use your name and mention you are powered by ${providerLabel}.`,
    '',
    '## Runtime',
    `- **Provider**: ${providerLabel}`,
    `- **Mode**: ${isHostMode ? 'Host (running directly on the machine)' : 'Container (Docker sandbox)'}`,
    `- **OS**: ${os.type()} ${os.release()} (${os.arch()})`,
    `- **Node**: ${process.version}`,
    `- **User**: ${os.userInfo().username}`,
    `- **Working directory**: ${process.cwd()}`,
    `- **Model**: ${containerInput.model || process.env.COPILOT_MODEL || 'default'}`,
  ];
  if (isHostMode) {
    runtimeLines.push('- **Persistence**: Full — all files and installed software persist');
    runtimeLines.push('- **Access**: Direct host filesystem access');
  } else {
    runtimeLines.push('- **Persistence**: Only /workspace/group persists across restarts');
    runtimeLines.push('- **Sudo**: Available (passwordless)');
  }
  if (containerInput.agentId) {
    runtimeLines.push(`- **Agent ID**: ${containerInput.agentId}`);
  }
  runtimeLines.push(
    `- **Main chat**: ${containerInput.isDefaultAgent ? 'Yes — you can use nanoclaw_control to change config and restart' : 'No — nanoclaw_control is not available (config changes require the main chat)'}`,
  );

  // Scheduled-tasks capability hint (kenan 2026-05-11): the SDK already
  // exposes the `nanoclaw` MCP tools to the model via `tools[]`, but the
  // tool descriptions alone weren't enough to reliably prompt task
  // creation. Add an explicit cue so users asking "remind me…", "every
  // morning…", "in N minutes…" reliably get a `schedule_task` call
  // instead of an in-line answer the agent can't actually deliver later.
  // Skip during scheduled-task runs themselves (the task agent doesn't
  // need to recursively schedule from inside its own run).
  if (!containerInput.isScheduledTask) {
    runtimeLines.push('');
    runtimeLines.push('## Available scheduling tools');
    runtimeLines.push('You have MCP tools to schedule recurring or one-time work for this chat:');
    runtimeLines.push('- `schedule_task` — create a task (cron / interval / once). Use when the user');
    runtimeLines.push('  says "remind me…", "every day at…", "in N minutes", "daily summary", etc.');
    runtimeLines.push('- `list_tasks` / `update_task` / `pause_task` / `resume_task` / `cancel_task` —');
    runtimeLines.push('  inspect or change existing tasks for this chat.');
    runtimeLines.push('Each task runs as a fresh agent invocation in its own container slot, in');
    runtimeLines.push('parallel with normal chat (it will not block the chat). Pick `context_mode`');
    runtimeLines.push('per the tool description: `isolated` for self-contained jobs, `group` when');
    runtimeLines.push("the task needs the chat's ongoing conversation context.");
  }

  const identityPrompt = runtimeLines.join('\n');

  // Load global agent prompt as additional system context
  // GHC prefers COPILOT.md over CLAUDE.md when available
  let systemMessage: { mode: 'append'; content: string } | undefined;
  let globalPromptPath: string;
  if (process.env.NANOCLAW_GLOBAL_CLAUDE_MD) {
    // Host-runner already resolved the correct file (COPILOT.md or CLAUDE.md)
    globalPromptPath = process.env.NANOCLAW_GLOBAL_CLAUDE_MD;
  } else {
    // Docker mode: check for COPILOT.md first, fall back to CLAUDE.md
    const copilotPath = '/workspace/global/COPILOT.md';
    const claudePath = '/workspace/global/CLAUDE.md';
    globalPromptPath = fs.existsSync(copilotPath) ? copilotPath : claudePath;
  }
  if (!containerInput.isDefaultAgent && fs.existsSync(globalPromptPath)) {
    systemMessage = {
      mode: 'append',
      content: identityPrompt + '\n\n' + fs.readFileSync(globalPromptPath, 'utf-8'),
    };
  } else {
    systemMessage = {
      mode: 'append',
      content: identityPrompt,
    };
  }

  // Discover additional directories and skill directories
  const extraDirs: string[] = [];
  const extraBase = process.env.NANOCLAW_EXTRA_DIR || '/workspace/extra';
  if (fs.existsSync(extraBase)) {
    for (const entry of fs.readdirSync(extraBase)) {
      const fullPath = path.join(extraBase, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
  }

  // Default skill directory: ~/.nanoclaw/skills (mounted from host)
  // Each subdirectory is a skill containing SKILL.md
  const skillsDir = process.env.NANOCLAW_SKILLS_DIR || '/workspace/skills';
  if (fs.existsSync(skillsDir)) {
    // Add the skills directory itself (GHC CLI scans subdirs for SKILL.md)
    extraDirs.push(skillsDir);
    // Also add each skill subdirectory individually as a fallback
    for (const entry of fs.readdirSync(skillsDir)) {
      const fullPath = path.join(skillsDir, entry);
      if (fs.statSync(fullPath).isDirectory()) {
        extraDirs.push(fullPath);
      }
    }
    log(`Skills directory loaded: ${skillsDir} (${extraDirs.length} entries)`);
  }

  // Initialize Copilot SDK client with explicit token if available.
  // Priority: env vars > useLoggedInUser (CLI managed auth).
  function resolveGithubToken(): string | undefined {
    // 1. Explicit env vars (highest priority)
    const envToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
    if (envToken) {
      log('Using GitHub token from environment variable');
      return envToken;
    }

    // 2. Fall back to useLoggedInUser (CLI managed auth)
    log('No explicit token found, falling back to CLI managed auth');
    return undefined;
  }

  const githubToken = resolveGithubToken();

  // Plugin directories (passed from host-runner or set manually).
  //
  // We pass `--plugin-dir` via cliArgs even though the SDK's server-mode
  // currently drops it (verified upstream gap, GHC SDK 0.2.2 — see
  // load-plugin-agents.ts). Keeping the flag costs nothing and lets us shed
  // the workaround the moment upstream fixes it.
  //
  // For the workaround itself we walk the same dirs ourselves and turn each
  // plugin's agents/*.md into customAgents in the SessionConfig below.
  const pluginDirs: string[] = [];
  const pluginCliArgs: string[] = [];
  if (process.env.NANOCLAW_PLUGIN_DIRS) {
    for (const dir of process.env.NANOCLAW_PLUGIN_DIRS.split(path.delimiter)) {
      if (dir && fs.existsSync(dir)) {
        pluginDirs.push(dir);
        pluginCliArgs.push('--plugin-dir', dir);
        log(`Plugin directory: ${dir}`);
      }
    }
  }

  const pluginCustomAgents = loadPluginAgents(pluginDirs, {
    onWarn: (msg) => log(msg),
  });
  if (pluginCustomAgents.length > 0) {
    log(
      `Loaded ${pluginCustomAgents.length} custom agent(s) from plugin dirs: ${pluginCustomAgents
        .map((a) => `${a.name}@${path.basename(a.pluginDir)}`)
        .join(', ')}`,
    );
  }

  const clientOpts: any = {};
  if (githubToken) clientOpts.githubToken = githubToken;
  if (pluginCliArgs.length > 0) clientOpts.cliArgs = pluginCliArgs;

  const client = new CopilotClient(clientOpts);

  // Determine model: use container input model, env var, or default
  // Strip provider prefix if present (e.g. github-copilot/claude-sonnet-4 → claude-sonnet-4)
  let model = containerInput.model || process.env.COPILOT_MODEL || 'claude-sonnet-4';
  if (model.includes('/')) {
    model = model.split('/').slice(1).join('/');
  }
  const thinkLevel = process.env.COPILOT_THINK_LEVEL || undefined; // low|medium|high|xhigh

  let sessionId = containerInput.sessionId;

  // Session persists across the query loop — only created/resumed once
  let session: any = null;

  try {
    // Query loop: run query → wait for IPC message → repeat
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, model: ${model})...`);

      // sessionConfig for create/resume (not used when reusing existing session)
      const sessionConfig = {
        model,
        ...(thinkLevel ? { reasoningEffort: thinkLevel as any } : {}),
        // Don't pass configDir — it makes the CLI look for credentials in sessionDir
        // instead of ~/.copilot/, breaking auth on Windows.
        // Enable config discovery so CLI reads ~/.mcp.json and other MCP configs
        enableConfigDiscovery: process.env.NANOCLAW_MCP_DISCOVERY === '1',
        // Workaround for GHC SDK 0.2.2 server-mode --plugin-dir gap: pass
        // plugin agents directly via SessionConfig.customAgents.
        ...(pluginCustomAgents.length > 0
          ? {
              customAgents: pluginCustomAgents.map((a) => ({
                name: a.name,
                ...(a.displayName ? { displayName: a.displayName } : {}),
                ...(a.description ? { description: a.description } : {}),
                ...(a.tools ? { tools: a.tools } : {}),
                prompt: a.prompt,
              })),
            }
          : {}),
        systemMessage,
        workingDirectory: process.env.NANOCLAW_WORK_DIR || '/workspace/group',
        onPermissionRequest: approveAll,
        streaming: true,
        // Catch all session events for MCP OAuth and debugging
        onEvent: (event: any) => {
          if (event.type === 'mcp.oauth_required') {
            log(`[MCP OAuth] *** AUTH REQUIRED ***`);
            log(`[MCP OAuth] Server: ${event.data?.serverName} (${event.data?.serverUrl})`);
            log(`[MCP OAuth] Request ID: ${event.data?.requestId}`);
            if (event.data?.staticClientConfig) {
              log(`[MCP OAuth] Client ID: ${event.data.staticClientConfig.clientId}`);
            }
          } else if (event.type === 'mcp.oauth_completed') {
            log(`[MCP OAuth] Auth completed: ${event.data?.requestId}`);
          } else if (event.type === 'session.warning') {
            log(`[Session Warning] ${event.data?.warningType}: ${event.data?.message}`);
          } else if (event.type === 'session.error') {
            log(`[Session Error] ${event.data?.errorType}: ${event.data?.message}`);
          } else if (event.type === 'session.info' && event.data?.infoType === 'mcp') {
            log(`[MCP Info] ${event.data?.message}`);
          } else {
            // Tool-call lifecycle — forward as progress envelopes for the
            // host dispatcher's progress-draft lane. Failures here are
            // best-effort (writeOutput logs on its own); never let a bad
            // event payload abort the turn.
            const env = toProgressEnvelope(event);
            if (env) writeProgressEnvelope(env);
          }
        },
        // NanoClaw MCP server for IPC (send_message, schedule_task, etc.)
        mcpServers: {
          nanoclaw: {
            type: 'local' as const,
            command: 'node',
            args: [mcpServerPath],
            env: {
              NANOCLAW_CHAT_JID: containerInput.chatJid,
              NANOCLAW_GROUP_FOLDER: containerInput.groupFolder,
              // v2-only (PR #49): only NANOCLAW_IS_DEFAULT_AGENT remains;
              // legacy NANOCLAW_IS_MAIN was retired with the v1 isMain field.
              NANOCLAW_IS_DEFAULT_AGENT: containerInput.isDefaultAgent ? '1' : '0',
              NANOCLAW_TRIGGERING_USER_ID: containerInput.triggeringUserId ?? '',
            },
            tools: ['*'],
          },
          // GitHub MCP server (web_search, issues, PRs, code search, etc.)
          // Enabled via NANOCLAW_GITHUB_MCP=1 env var (set by host-runner/container-runner)
          ...(process.env.NANOCLAW_GITHUB_MCP === '1' && githubToken
            ? {
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
              }
            : {}),
          // Load additional MCP servers from /workspace/mcp.json (mounted from ~/.nanoclaw/mcp.json)
          ...(() => {
            const mcpConfigPath = process.env.NANOCLAW_MCP_CONFIG || '/workspace/mcp.json';
            if (fs.existsSync(mcpConfigPath)) {
              try {
                const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
                const servers = mcpConfig.mcpServers || mcpConfig;
                // Normalize: SDK requires tools[] (mandatory), strip nanoclaw-internal fields
                for (const [, cfg] of Object.entries(servers) as any[]) {
                  if (!cfg.tools) cfg.tools = ['*'];
                  delete cfg.auth; // nanoclaw internal, SDK doesn't recognize
                }
                log(`Loaded ${Object.keys(servers).length} MCP server(s) from ${mcpConfigPath}`);
                return servers;
              } catch (err) {
                log(`Failed to parse ${mcpConfigPath}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
            return {};
          })(),
          // Auto-discover built-in MCP servers from mcp-servers/ directory
          // Each subdirectory with an index.js is registered as a local MCP server.
          // This keeps agent-runner decoupled — no hardcoded MCP server references.
          ...(() => {
            const mcpServersDir = path.join(__dirname, '..', 'mcp-servers');
            const servers: Record<string, any> = {};
            if (fs.existsSync(mcpServersDir)) {
              for (const entry of fs.readdirSync(mcpServersDir)) {
                const serverDir = path.join(mcpServersDir, entry);
                // Check dist/index.js first (compiled), then index.js
                const distJs = path.join(serverDir, 'dist', 'index.js');
                const indexJs = path.join(serverDir, 'index.js');
                const entryPoint = fs.existsSync(distJs) ? distJs : fs.existsSync(indexJs) ? indexJs : null;
                if (entryPoint) {
                  servers[`nanoclaw-${entry}`] = {
                    type: 'local' as const,
                    command: 'node',
                    args: [entryPoint],
                    tools: ['*'],
                  };
                  log(`Discovered built-in MCP server: nanoclaw-${entry}`);
                }
              }
            }
            return servers;
          })(),
        },
        // Skill directories for additional capabilities
        skillDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      };

      // NOTE: Layer 1 of GHC session recovery — always re-resume by sessionId
      // on every iteration. We intentionally do NOT short-circuit on `if (session)
      // reuse`. The Copilot SDK evicts sessions from its in-memory `activeSessions`
      // map between query iterations (idle timeout / connection touch / process
      // churn). A stale `session` object only holds an RPC handle; the server-side
      // state is gone, and `session.send()` then throws `Session not found: <id>`,
      // killing the agent-runner subprocess and freezing host-side typing.
      // resumeSession is idempotent and cheap when the session is still alive.
      //
      // Layer 2 (mid-turn eviction during send) lives at the session.send call
      // site below: catch /Session not found/i → set session=null → continue →
      // loop top re-routes here. Together the layers cover both failure modes.
      if (sessionId) {
        // Resume existing session (first iteration or after error)
        try {
          session = await client.resumeSession(sessionId, sessionConfig);
          // Always reload MCP connections after resume to pick up new/changed tools
          try {
            await session.rpc.mcp.reload();
            log(`Resumed session: ${sessionId} (MCP reloaded)`);
          } catch {
            log(`Resumed session: ${sessionId} (MCP reload skipped)`);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // NOTE: We do NOT silently strip reasoningEffort here.
          // If the user's configured think level is rejected by the model,
          // surface the real CAPI error so the user can pick a valid level
          // or a model that supports it. (Removed in revert of PR #149.)
          log(`Failed to resume session ${sessionId}, creating new: ${errMsg}`);
          session = await client.createSession({
            ...sessionConfig,
            sessionId: randomUUID(),
          });
          sessionId = session.sessionId;
          log(`New session created: ${sessionId}`);
        }
      } else {
        // Create new session (first time).
        // No reasoningEffort fallback: surface the SDK error verbatim if the
        // configured think level is incompatible with the chosen model.
        session = await client.createSession({
          ...sessionConfig,
          sessionId: randomUUID(),
        });
        sessionId = session.sessionId;
        log(`Session created: ${sessionId}`);
      }

      // Poll IPC for follow-up messages during query execution
      let ipcPolling = true;
      let closedDuringQuery = false;
      const queuedIpcMessages: string[] = [];

      const pollIpcDuringQuery = () => {
        if (!ipcPolling) return;
        if (shouldClose()) {
          log('Close sentinel detected during query');
          closedDuringQuery = true;
          ipcPolling = false;
          return;
        }
        const messages = drainIpcInput();
        for (const text of messages) {
          log(`Queuing IPC message (${text.length} chars) — will send after current query`);
          queuedIpcMessages.push(text);
        }
        setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
      };
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

      // Send prompt and stream results
      let lastContent: string | null = null as string | null;
      let streamedChunks = 0;

      // Delta streaming: accumulate tokens, emit partial output periodically
      let deltaBuffer = '';
      let deltaTimer: ReturnType<typeof setTimeout> | null = null;
      const DELTA_FLUSH_MS = 1500; // Flush accumulated delta every 1.5s

      const flushDelta = () => {
        if (deltaBuffer.length > 0) {
          writeOutput({
            status: 'success',
            result: deltaBuffer,
            newSessionId: sessionId,
            partial: true,
          });
          log(`Delta flush: ${deltaBuffer.length} chars`);
        }
      };

      const scheduleDeltaFlush = () => {
        if (!deltaTimer) {
          deltaTimer = setTimeout(() => {
            deltaTimer = null;
            flushDelta();
          }, DELTA_FLUSH_MS);
        }
      };

      const idlePromise = new Promise<void>((resolve, reject) => {
        const cleanups: Array<() => void> = [];
        const cleanupAll = () => {
          for (const fn of cleanups) fn();
          cleanups.length = 0;
        };

        cleanups.push(
          session.on('session.idle' as any, () => {
            cleanupAll();
            // Flush any remaining delta
            if (deltaTimer) {
              clearTimeout(deltaTimer);
              deltaTimer = null;
            }
            flushDelta();
            deltaBuffer = '';
            resolve();
          }),
        );

        // Delta streaming: accumulate token-by-token output
        cleanups.push(
          session.on('assistant.message_delta' as any, (event: any) => {
            const delta = event.data?.deltaContent || event.data?.content || '';
            if (delta) {
              deltaBuffer += delta;
              scheduleDeltaFlush();
            }
          }),
        );

        // Reasoning events (SDK 0.2.2+) — stream thinking content
        let thinkingBuffer = '';
        let thinkingDeltaTimer: ReturnType<typeof setTimeout> | null = null;
        const flushThinkingDelta = () => {
          if (thinkingBuffer) {
            writeOutput({
              status: 'thinking' as any,
              result: null,
              thinking: thinkingBuffer,
              partial: true,
              newSessionId: sessionId,
            });
          }
        };
        cleanups.push(
          session.on('assistant.reasoning_delta' as any, (event: any) => {
            const delta = event.data?.content || event.data?.deltaContent || '';
            if (delta) {
              thinkingBuffer += delta;
              // Throttle thinking delta output (every 500ms)
              if (!thinkingDeltaTimer) {
                thinkingDeltaTimer = setTimeout(() => {
                  thinkingDeltaTimer = null;
                  flushThinkingDelta();
                }, 500);
              }
            }
          }),
        );

        cleanups.push(
          session.on('assistant.reasoning' as any, (event: any) => {
            const content = event.data?.content || '';
            if (content) {
              thinkingBuffer = content;
            }
            // Flush final thinking
            if (thinkingDeltaTimer) {
              clearTimeout(thinkingDeltaTimer);
              thinkingDeltaTimer = null;
            }
            flushThinkingDelta();
            log(`Reasoning complete: ${thinkingBuffer.slice(0, 100)}...`);
          }),
        );

        // Full message: send complete result (replaces any partial)
        cleanups.push(
          session.on('assistant.message' as any, (event: any) => {
            if (event.data?.content) {
              lastContent = event.data.content;
              // Cancel pending delta flush — full message supersedes it
              if (deltaTimer) {
                clearTimeout(deltaTimer);
                deltaTimer = null;
              }
              deltaBuffer = '';

              // Extract thinking from multiple sources:
              // 1. Reasoning events (thinkingBuffer)
              // 2. assistant.message.reasoningText field
              // 3. <thinking> tags in content
              let thinking = thinkingBuffer || event.data.reasoningText || '';
              let visibleContent = event.data.content;

              // Parse <thinking> tags from content if no other source
              if (!thinking) {
                const tagMatch = visibleContent.match(
                  /^\s*<\s*(?:think(?:ing)?|thought)\s*>([\s\S]*?)<\s*\/\s*(?:think(?:ing)?|thought)\s*>/i,
                );
                if (tagMatch) {
                  thinking = tagMatch[1].trim();
                  visibleContent = visibleContent.slice(tagMatch[0].length).trim();
                }
              }

              // Write final output with thinking separated
              writeOutput({
                status: 'success',
                result: visibleContent,
                newSessionId: sessionId,
                ...(thinking ? { thinking } : {}),
              });
              thinkingBuffer = '';
              streamedChunks++;
              log(
                `Streamed result #${streamedChunks}: ${visibleContent.slice(0, 100)}...${thinking ? ` (thinking: ${thinking.slice(0, 50)}...)` : ''}`,
              );
            }
          }),
        );

        cleanups.push(
          session.on('session.error' as any, (event: any) => {
            cleanupAll();
            if (deltaTimer) {
              clearTimeout(deltaTimer);
              deltaTimer = null;
            }
            reject(new Error(event.data?.message || 'Session error'));
          }),
        );
      });

      // Layer 2 of GHC session-recovery: catch mid-turn `Session not found`.
      // SDK can evict the session during send (network blip / Copilot CLI
      // subprocess restart / connection drop). Layer 1 above only handles
      // between-turn eviction. When this hits, we can't cleanly retry within
      // the current iteration because the Promise/listeners are bound to the
      // dead session object. Instead: stop IPC polling, drop the stale session,
      // and `continue` so the loop top re-resumes (or creates new) and re-binds
      // listeners fresh. Same `prompt` is preserved (not yet overwritten).
      try {
        await session.send({ prompt });
        await idlePromise;
      } catch (sendErr) {
        const sendErrMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
        if (isSessionNotFoundError(sendErr) && sessionId) {
          log(`session.send hit Session not found mid-turn, recovering: ${sendErrMsg}`);
          ipcPolling = false;
          session = null; // force loop top to re-resume
          continue; // re-enter loop with same prompt
        }
        // Unrelated error: rethrow to outer handler
        throw sendErr;
      }
      ipcPolling = false;

      log(`Query done. Streamed ${streamedChunks} result(s).`);

      if (closedDuringQuery) {
        log('Close sentinel consumed during query, exiting');
        break;
      }

      // Emit session update
      writeOutput({ status: 'success', result: null, newSessionId: sessionId });

      log('Query ended, waiting for next IPC message...');

      // Check for messages queued during the query before polling for new ones
      let nextMessage: string | null;
      if (queuedIpcMessages.length > 0) {
        nextMessage = queuedIpcMessages.join('\n');
        queuedIpcMessages.length = 0;
        log(`Using ${nextMessage.length} chars queued during query`);
      } else {
        nextMessage = await waitForIpcMessage();
      }

      if (nextMessage === null) {
        log('Close sentinel received, exiting');
        break;
      }

      log(`Got new message (${nextMessage.length} chars), starting new query`);
      prompt = nextMessage;
    }

    // Disconnect session gracefully
    try {
      log('Disconnecting session...');
      await client.stop();
    } catch (err) {
      log(`Session disconnect error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    log(`Agent error: ${errorMessage}`);
    writeOutput({
      status: 'error',
      result: null,
      newSessionId: sessionId,
      error: errorMessage,
    });
    try {
      await client.stop();
    } catch {
      /* ignore */
    }
    process.exit(1);
  }
}

main();
