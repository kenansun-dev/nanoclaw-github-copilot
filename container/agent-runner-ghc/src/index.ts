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

interface ContainerInput {
  prompt: string;
  sessionId?: string;
  groupFolder: string;
  chatJid: string;
  isMain: boolean;
  isScheduledTask?: boolean;
  assistantName?: string;
  model?: string;
  agentId?: string;
}

interface ContainerOutput {
  status: 'success' | 'error' | 'thinking';
  result: string | null;
  newSessionId?: string;
  error?: string;
  partial?: boolean;
  thinking?: string;
}

const IPC_INPUT_DIR = process.env.NANOCLAW_IPC_DIR || '/workspace/ipc/input';
const IPC_INPUT_CLOSE_SENTINEL = path.join(IPC_INPUT_DIR, '_close');
const IPC_POLL_MS = 500;

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
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

function log(message: string): void {
  console.error(`[agent-runner] ${message}`);
}

function shouldClose(): boolean {
  if (fs.existsSync(IPC_INPUT_CLOSE_SENTINEL)) {
    try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }
    return true;
  }
  return false;
}

function drainIpcInput(): string[] {
  try {
    fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
    const files = fs.readdirSync(IPC_INPUT_DIR)
      .filter(f => f.endsWith('.json'))
      .sort();

    const messages: string[] = [];
    for (const file of files) {
      const filePath = path.join(IPC_INPUT_DIR, file);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        fs.unlinkSync(filePath);
        if (data.type === 'message' && data.text) {
          messages.push(data.text);
        }
      } catch (err) {
        log(`Failed to process input file ${file}: ${err instanceof Error ? err.message : String(err)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignore */ }
      }
    }
    return messages;
  } catch (err) {
    log(`IPC drain error: ${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}

function waitForIpcMessage(): Promise<string | null> {
  return new Promise((resolve) => {
    const poll = () => {
      // Drain messages BEFORE checking close sentinel — prevents race where
      // _close arrives before a pending message file is read
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
        return;
      }
      if (shouldClose()) {
        resolve(null);
        return;
      }
      setTimeout(poll, IPC_POLL_MS);
    };
    poll();
  });
}

/**
 * Archive conversation transcript before it gets too long.
 */
function archiveConversation(
  messages: Array<{ role: string; content: string }>,
  assistantName?: string,
): void {
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
    lines.push(`Archived: ${time.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true })}`);
    lines.push('');
    lines.push('---');
    lines.push('');

    for (const msg of messages) {
      const sender = msg.role === 'user' ? 'User' : (assistantName || 'Assistant');
      const content = msg.content.length > 2000
        ? msg.content.slice(0, 2000) + '...'
        : msg.content;
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
    try { fs.unlinkSync('/tmp/input.json'); } catch { /* may not exist */ }
    log(`Received input for group: ${containerInput.groupFolder}`);
  } catch (err) {
    writeOutput({
      status: 'error',
      result: null,
      error: `Failed to parse input: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }

  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  // Resolve IPC MCP server path.
  // Compiled mode: __dirname = dist/, ipc-mcp-stdio.js exists locally.
  // Dev mode (tsx): __dirname = src/, .js missing → use ../dist/.
  const localJs = path.join(__dirname, 'ipc-mcp-stdio.js');
  const distJs = path.join(__dirname, '..', 'dist', 'ipc-mcp-stdio.js');
  const mcpServerPath = fs.existsSync(localJs) ? localJs : distJs;

  fs.mkdirSync(IPC_INPUT_DIR, { recursive: true });
  try { fs.unlinkSync(IPC_INPUT_CLOSE_SENTINEL); } catch { /* ignore */ }

  // Build initial prompt
  let prompt = containerInput.prompt;
  if (containerInput.isScheduledTask) {
    prompt = `[SCHEDULED TASK - The following message was sent automatically and is not coming directly from the user or group.]\n\n${prompt}`;
  }
  const pending = drainIpcInput();
  if (pending.length > 0) {
    log(`Draining ${pending.length} pending IPC messages into initial prompt`);
    prompt += '\n' + pending.join('\n');
  }

  // Build dynamic identity + runtime info
  const agentName = containerInput.assistantName || 'Andy';
  const isHostMode = process.env.NANOCLAW_HOST_MODE === '1';
  const modelStr = containerInput.model || process.env.COPILOT_MODEL || 'default';
  const provider = modelStr.includes('/') ? modelStr.split('/')[0] : 'unknown';
  const providerLabel = provider === 'github-copilot' ? 'GitHub Copilot'
    : provider === 'anthropic' ? 'Claude (Anthropic)'
    : provider;
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
  runtimeLines.push(`- **Main chat**: ${containerInput.isMain ? 'Yes — you can use nanoclaw_control to change config and restart' : 'No — nanoclaw_control is not available (config changes require the main chat)'}`);
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
  if (!containerInput.isMain && fs.existsSync(globalPromptPath)) {
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
    const envToken = process.env.COPILOT_GITHUB_TOKEN
      || process.env.GH_TOKEN
      || process.env.GITHUB_TOKEN;
    if (envToken) {
      log('Using GitHub token from environment variable');
      return envToken;
    }

    // 2. Fall back to useLoggedInUser (CLI managed auth)
    log('No explicit token found, falling back to CLI managed auth');
    return undefined;
  }

  const githubToken = resolveGithubToken();

  // Plugin directories (passed from host-runner or set manually)
  const pluginCliArgs: string[] = [];
  if (process.env.NANOCLAW_PLUGIN_DIRS) {
    for (const dir of process.env.NANOCLAW_PLUGIN_DIRS.split(path.delimiter)) {
      if (dir && fs.existsSync(dir)) {
        pluginCliArgs.push('--plugin-dir', dir);
        log(`Plugin directory: ${dir}`);
      }
    }
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
        // Use nanoclaw-managed config directory (set via NANOCLAW_CONFIG_DIR env)
        ...(process.env.NANOCLAW_CONFIG_DIR ? { configDir: process.env.NANOCLAW_CONFIG_DIR } : 
            process.env.COPILOT_HOME ? { configDir: process.env.COPILOT_HOME } : {}),
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
              NANOCLAW_IS_MAIN: containerInput.isMain ? '1' : '0',
            },
            tools: ['*'],
          },
          // GitHub MCP server (web_search, issues, PRs, code search, etc.)
          // Enabled via NANOCLAW_GITHUB_MCP=1 env var (set by host-runner/container-runner)
          ...(process.env.NANOCLAW_GITHUB_MCP === '1' && githubToken ? {
            'github-mcp-server': {
              type: 'http' as const,
              url: 'https://api.githubcopilot.com/mcp',
              headers: {
                'Authorization': `Bearer ${githubToken}`,
                'X-MCP-Toolsets': 'repos,issues,users,pull_requests,code_security,secret_protection,actions,web_search',
                'X-MCP-Host': 'copilot-cli',
                'X-Initiator': 'agent',
              },
              tools: ['*'],
            },
          } : {}),
          // Load additional MCP servers from /workspace/mcp.json (mounted from ~/.nanoclaw/mcp.json)
          ...(() => {
            const mcpConfigPath = process.env.NANOCLAW_MCP_CONFIG || '/workspace/mcp.json';
            if (fs.existsSync(mcpConfigPath)) {
              try {
                const mcpConfig = JSON.parse(fs.readFileSync(mcpConfigPath, 'utf-8'));
                const servers = mcpConfig.mcpServers || mcpConfig;
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

      if (session) {
        // Session already exists from previous iteration â reuse it
        log(`Reusing existing session: ${sessionId}`);
      } else if (sessionId) {
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
          // If reasoningEffort caused the resume failure, retry without it
          if ((errMsg.includes('reasoning') || errMsg.includes('reasoningEffort')) && sessionConfig.reasoningEffort) {
            log(`Resume failed due to reasoningEffort, retrying without it`);
            try {
              session = await client.resumeSession(sessionId, { ...sessionConfig, reasoningEffort: undefined });
              try { await session.rpc.mcp.reload(); } catch {}
              log(`Resumed session without reasoningEffort: ${sessionId}`);
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              log(`Failed to resume session ${sessionId}, creating new: ${retryMsg}`);
              session = null;
              sessionId = undefined;
            }
          } else {
            log(`Failed to resume session ${sessionId}, creating new: ${errMsg}`);
            // If model doesn't support reasoningEffort, retry without it
            const createConfig = errMsg.includes('reasoning') || errMsg.includes('reasoningEffort')
              ? { ...sessionConfig, reasoningEffort: undefined }
              : sessionConfig;
            try {
              session = await client.createSession({
                ...createConfig,
                sessionId: randomUUID(),
              });
            } catch (createErr) {
              // Retry without reasoningEffort as last resort
              const createErrMsg = createErr instanceof Error ? createErr.message : String(createErr);
              if (createErrMsg.includes('reasoning') && createConfig.reasoningEffort) {
                log(`Model does not support reasoningEffort, retrying without it`);
                session = await client.createSession({
                  ...sessionConfig,
                  reasoningEffort: undefined,
                  sessionId: randomUUID(),
                });
              } else {
                throw createErr;
              }
            }
            sessionId = session.sessionId;
            log(`New session created: ${sessionId}`);
          }
        }
      } else {
                // Create new session (first time)
        try {
          session = await client.createSession({
            ...sessionConfig,
            sessionId: randomUUID(),
          });
        } catch (createErr) {
          const msg = createErr instanceof Error ? createErr.message : String(createErr);
          if (msg.includes('reasoning') && (sessionConfig as any).reasoningEffort) {
            log(`Model does not support reasoningEffort, creating session without it`);
            session = await client.createSession({
              ...sessionConfig,
              reasoningEffort: undefined,
              sessionId: randomUUID(),
            });
          } else {
            throw createErr;
          }
        }
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
        const cleanupAll = () => { for (const fn of cleanups) fn(); cleanups.length = 0; };

        cleanups.push(session.on('session.idle' as any, () => {
          cleanupAll();
          // Flush any remaining delta
          if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
          flushDelta();
          deltaBuffer = '';
          resolve();
        }));

        // Delta streaming: accumulate token-by-token output
        cleanups.push(session.on('assistant.message_delta' as any, (event: any) => {
          const delta = event.data?.deltaContent || event.data?.content || '';
          if (delta) {
            deltaBuffer += delta;
            scheduleDeltaFlush();
          }
        }));

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
        cleanups.push(session.on('assistant.reasoning_delta' as any, (event: any) => {
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
        }));

        cleanups.push(session.on('assistant.reasoning' as any, (event: any) => {
          const content = event.data?.content || '';
          if (content) {
            thinkingBuffer = content;
          }
          // Flush final thinking
          if (thinkingDeltaTimer) { clearTimeout(thinkingDeltaTimer); thinkingDeltaTimer = null; }
          flushThinkingDelta();
          log(`Reasoning complete: ${thinkingBuffer.slice(0, 100)}...`);
        }));

        // Full message: send complete result (replaces any partial)
        cleanups.push(session.on('assistant.message' as any, (event: any) => {
          if (event.data?.content) {
            lastContent = event.data.content;
            // Cancel pending delta flush — full message supersedes it
            if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
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
                /^\s*<\s*(?:think(?:ing)?|thought)\s*>([\s\S]*?)<\s*\/\s*(?:think(?:ing)?|thought)\s*>/i
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
            log(`Streamed result #${streamedChunks}: ${visibleContent.slice(0, 100)}...${thinking ? ` (thinking: ${thinking.slice(0, 50)}...)` : ''}`);
          }
        }));

        cleanups.push(session.on('session.error' as any, (event: any) => {
          cleanupAll();
          if (deltaTimer) { clearTimeout(deltaTimer); deltaTimer = null; }
          reject(new Error(event.data?.message || 'Session error'));
        }));
      });

      await session.send({ prompt });
      await idlePromise;
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
    try { await client.stop(); } catch { /* ignore */ }
    process.exit(1);
  }
}

main();
