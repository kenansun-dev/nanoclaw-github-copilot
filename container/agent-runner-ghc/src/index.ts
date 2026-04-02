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
}

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
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
  console.log(OUTPUT_START_MARKER);
  console.log(JSON.stringify(output));
  console.log(OUTPUT_END_MARKER);
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
      if (shouldClose()) {
        resolve(null);
        return;
      }
      const messages = drainIpcInput();
      if (messages.length > 0) {
        resolve(messages.join('\n'));
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
  const mcpServerPath = path.join(__dirname, 'ipc-mcp-stdio.js');

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
  const identityPrompt = runtimeLines.join('\n');

  // Load global CLAUDE.md as additional system context
  let systemMessage: { mode: 'append'; content: string } | undefined;
  const globalClaudeMdPath = process.env.NANOCLAW_GLOBAL_CLAUDE_MD || '/workspace/global/CLAUDE.md';
  if (!containerInput.isMain && fs.existsSync(globalClaudeMdPath)) {
    systemMessage = {
      mode: 'append',
      content: identityPrompt + '\n\n' + fs.readFileSync(globalClaudeMdPath, 'utf-8'),
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
  // Priority: env vars > OpenClaw auth profile > useLoggedInUser (CLI managed auth).
  function resolveGithubToken(): string | undefined {
    // 1. Explicit env vars (highest priority)
    const envToken = process.env.COPILOT_GITHUB_TOKEN
      || process.env.GH_TOKEN
      || process.env.GITHUB_TOKEN;
    if (envToken) {
      log('Using GitHub token from environment variable');
      return envToken;
    }

    // 2. OpenClaw auth profile (no keychain needed)
    const openclawPaths = [
      path.join(process.env.HOME || '/root', '.openclaw/agents/main/agent/auth-profiles.json'),
    ];
    for (const profilePath of openclawPaths) {
      try {
        if (fs.existsSync(profilePath)) {
          const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          // Find any github-copilot profile with a token
          for (const [key, profile] of Object.entries(profiles.profiles || {})) {
            const p = profile as { type?: string; provider?: string; token?: string };
            if (p.provider === 'github-copilot' && p.token) {
              log(`Using GitHub token from OpenClaw auth profile: ${key}`);
              return p.token;
            }
          }
        }
      } catch (err) {
        log(`Failed to read OpenClaw auth profile at ${profilePath}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // 3. Fall back to useLoggedInUser (CLI managed auth)
    log('No explicit token found, falling back to CLI managed auth');
    return undefined;
  }

  const githubToken = resolveGithubToken();

  const client = new CopilotClient(githubToken ? { githubToken } : undefined);

  // Determine model: use container input model, env var, or default
  const model = containerInput.model || process.env.COPILOT_MODEL || 'claude-sonnet-4';
  const thinkLevel = process.env.COPILOT_THINK_LEVEL || undefined; // low|medium|high|xhigh

  let sessionId = containerInput.sessionId;

  try {
    // Query loop: run query → wait for IPC message → repeat
    while (true) {
      log(`Starting query (session: ${sessionId || 'new'}, model: ${model})...`);

      let session;
      const sessionConfig = {
        model,
        ...(thinkLevel ? { reasoningEffort: thinkLevel as any } : {}),
        // Use nanoclaw-managed config directory (set via COPILOT_HOME env)
        ...(process.env.COPILOT_HOME ? { configDir: process.env.COPILOT_HOME } : {}),
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
        },
        // Skill directories for additional capabilities
        skillDirectories: extraDirs.length > 0 ? extraDirs : undefined,
      };

      if (sessionId) {
        // Resume existing session
        try {
          session = await client.resumeSession(sessionId, sessionConfig);
          log(`Resumed session: ${sessionId}`);
        } catch (err) {
          log(`Failed to resume session ${sessionId}, creating new: ${err instanceof Error ? err.message : String(err)}`);
          session = await client.createSession({
            ...sessionConfig,
            sessionId: `nanoclaw-${containerInput.groupFolder}-${Date.now()}`,
          });
          sessionId = session.sessionId;
          log(`New session created: ${sessionId}`);
        }
      } else {
        // Create new session
        session = await client.createSession({
          ...sessionConfig,
          sessionId: `nanoclaw-${containerInput.groupFolder}-${Date.now()}`,
        });
        sessionId = session.sessionId;
        log(`Session created: ${sessionId}`);
      }

      // Poll IPC for follow-up messages during query execution
      let ipcPolling = true;
      let closedDuringQuery = false;

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
          // Note: Copilot SDK doesn't support mid-query message injection like Claude SDK's
          // async iterable. Messages will be sent as new queries in the next loop iteration.
        }
        setTimeout(pollIpcDuringQuery, IPC_POLL_MS);
      };
      setTimeout(pollIpcDuringQuery, IPC_POLL_MS);

      // Send prompt and stream results (event-driven, like CC SDK's for-await pattern)
      let lastContent: string | null = null as string | null;
      let streamedChunks = 0;

      const idlePromise = new Promise<void>((resolve, reject) => {
        const cleanup = session.on('session.idle' as any, () => {
          cleanup();
          resolve();
        });

        // Stream: emit partial results as they arrive (like CC SDK's result messages)
        session.on('assistant.message' as any, (event: any) => {
          if (event.data?.content) {
            lastContent = event.data.content;
            // Write streaming output — host can send to user immediately
            writeOutput({
              status: 'success',
              result: event.data.content,
              newSessionId: sessionId,
            });
            streamedChunks++;
            log(`Streamed result #${streamedChunks}: ${event.data.content.slice(0, 100)}...`);
          }
        });

        session.on('session.error' as any, (event: any) => {
          cleanup();
          reject(new Error(event.data?.message || 'Session error'));
        });
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

      const nextMessage = await waitForIpcMessage();
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
