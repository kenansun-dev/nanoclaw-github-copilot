/**
 * nanoclaw tui — interactive terminal chat
 *
 * Connects to the running nanoclaw service via Unix domain socket.
 * Falls back to direct agent-runner spawn if service isn't running.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

import { loadConfig, saveConfig } from '../config-loader.js';
import { resolveWorkspace } from '../workspace.js';

const SOCK_NAME =
  process.platform === 'win32' ? '\\\\.\\pipe\\nanoclaw-tui' : 'tui.sock';

export async function runTui(_args: string[]): Promise<void> {
  // Parse --ask flag for non-interactive single query
  const askIdx = _args.indexOf('--ask');
  if (askIdx !== -1) {
    // Extract --model and --think from all args
    let model: string | undefined;
    let think: string | undefined;
    const filtered: string[] = [];
    let foundAsk = false;
    for (let i = 0; i < _args.length; i++) {
      if (_args[i] === '--ask') {
        foundAsk = true;
        continue;
      }
      if (_args[i] === '--model' && i + 1 < _args.length) {
        model = _args[++i];
        continue;
      }
      if (_args[i] === '--think' && i + 1 < _args.length) {
        think = _args[++i];
        continue;
      }
      if (foundAsk) filtered.push(_args[i]);
    }
    const query = filtered.join(' ').trim();
    if (!query) {
      console.error(
        'Usage: nanoclaw tui --ask "your question" [--model <model>] [--think <level>]',
      );
      process.exit(1);
    }
    return runTuiAsk(query, { model, think });
  }

  const config = loadConfig();
  const agent = config.agents?.defaults || {};
  const tuiCfg = (config as any).tui || {};

  const assistantName = tuiCfg.name || agent.name || 'Nanoclaw';
  const model = tuiCfg.model || agent.model || 'github-copilot/claude-sonnet-4';
  const thinkLevel = tuiCfg.thinkLevel || agent.thinkLevel;

  const ws = resolveWorkspace();
  const sockPath =
    process.platform === 'win32' ? SOCK_NAME : path.join(ws, 'tui.sock');

  console.log(`\n  ${assistantName} — Terminal Chat`);
  console.log(
    `  Model: ${model}${thinkLevel ? ` (think: ${thinkLevel})` : ''}`,
  );
  console.log(`  Commands: /new /think <level> /quit\n`);

  // Try to connect to running service
  let socket: net.Socket | null = null;
  try {
    socket = await connectToService(sockPath);
    console.log('  Connected to nanoclaw service ✓\n');
  } catch {
    console.log('  Service not running — starting direct mode\n');
    console.log('  Tip: run `nanoclaw start` for full service features\n');
    // Fall back to direct agent-runner spawn (legacy mode)
    const { runTuiDirect } = await import('./tui-direct.js');
    return runTuiDirect(_args);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  let currentAssistantName = assistantName;
  let waitingForReply = false;
  let spinTimer: ReturnType<typeof setInterval> | null = null;

  // Handle server messages
  let buffer = '';
  socket.on('data', (data) => {
    buffer += data.toString();
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.substring(0, newlineIdx).trim();
      buffer = buffer.substring(newlineIdx + 1);
      if (line) handleServerMessage(line);
    }
  });

  socket.on('close', () => {
    console.log('\nService disconnected. Bye 👋\n');
    rl.close();
    process.exit(0);
  });

  socket.on('error', (err) => {
    console.error(`\nConnection error: ${err.message}\n`);
    rl.close();
    process.exit(1);
  });

  function handleServerMessage(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'connected':
        if (msg.assistantName) currentAssistantName = msg.assistantName;
        break;

      case 'typing':
        if (msg.isTyping) {
          startSpinner();
        } else {
          stopSpinner();
        }
        break;

      case 'partial':
        stopSpinner();
        // Overwrite current line with partial text
        process.stdout.write(
          `\r\x1b[K\x1b[32m${currentAssistantName}>\x1b[0m ${msg.text}`,
        );
        break;

      case 'reply':
        stopSpinner();
        waitingForReply = false;
        process.stdout.write(
          `\r\x1b[K\x1b[32m${currentAssistantName}>\x1b[0m ${msg.text}\n\n`,
        );
        break;

      case 'error':
        stopSpinner();
        waitingForReply = false;
        console.error(`\x1b[31mError: ${msg.error}\x1b[0m\n`);
        break;

      case 'session_reset':
        console.log('🔄 Session reset.\n');
        break;
    }
  }

  const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let spinIdx = 0;

  function startSpinner() {
    if (spinTimer) return;
    spinIdx = 0;
    spinTimer = setInterval(() => {
      process.stdout.write(
        `\r${spinner[spinIdx++ % spinner.length]} thinking...`,
      );
    }, 100);
  }

  function stopSpinner() {
    if (spinTimer) {
      clearInterval(spinTimer);
      spinTimer = null;
      process.stdout.write('\r\x1b[K');
    }
  }

  // Ctrl+C — first press cancels waiting, second press exits
  let sigintCount = 0;
  process.on('SIGINT', () => {
    sigintCount++;
    if (sigintCount >= 2) {
      // Force exit on double Ctrl-C
      console.log('\nForce exit.\n');
      socket?.destroy();
      rl.close();
      process.exit(0);
    }
    if (waitingForReply) {
      stopSpinner();
      waitingForReply = false;
      console.log('\n⏹ Cancelled.\n');
      // Reset count after cancel so next single Ctrl-C exits cleanly
      setTimeout(() => { sigintCount = 0; }, 1000);
    } else {
      console.log('\nBye 👋\n');
      socket?.destroy();
      rl.close();
      process.exit(0);
    }
  });

  const prompt = (): Promise<string> =>
    new Promise((resolve) => {
      rl.question('\x1b[36myou>\x1b[0m ', (answer) => resolve(answer));
    });

  while (true) {
    const userInput = await prompt();
    const trimmed = userInput.trim();

    if (!trimmed) continue;

    if (trimmed === '/quit' || trimmed === '/exit') {
      console.log('\nBye 👋\n');
      socket.destroy();
      rl.close();
      process.exit(0);
    }

    if (trimmed === '/new' || trimmed === '/reset') {
      socket.write(JSON.stringify({ type: 'new_session' }) + '\n');
      continue;
    }

    // /think command (local config change)
    const thinkMatch = trimmed.match(
      /^\/think(?:\s+(off|low|medium|high|xhigh))?$/i,
    );
    if (thinkMatch) {
      const level = thinkMatch[1]?.toLowerCase();
      if (!level) {
        const current = loadConfig().agents?.defaults?.thinkLevel || 'off';
        console.log(`🧠 Think level: ${current}`);
        console.log('Usage: /think off|low|medium|high|xhigh\n');
      } else {
        const cfg = loadConfig();
        if (level === 'off') {
          delete cfg.agents.defaults.thinkLevel;
        } else {
          cfg.agents.defaults.thinkLevel = level as
            | 'low'
            | 'medium'
            | 'high'
            | 'xhigh';
        }
        saveConfig(cfg);
        console.log(`🧠 Think level: ${level}\n`);
      }
      continue;
    }

    // Send message to service
    waitingForReply = true;
    rl.pause();
    socket.write(JSON.stringify({ type: 'message', text: trimmed }) + '\n');

    // Wait for reply before showing next prompt
    await new Promise<void>((resolve) => {
      const check = setInterval(() => {
        if (!waitingForReply) {
          clearInterval(check);
          rl.resume();
          resolve();
        }
      }, 100);
    });
  }
}

function connectToService(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath, () => {
      // Clear the connection timeout once connected — the socket
      // should stay open indefinitely while waiting for agent replies.
      socket.setTimeout(0);
      resolve(socket);
    });
    socket.on('error', reject);
    // Timeout after 2 seconds for the initial connection only
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}

// ─── Non-interactive single query mode ───────────────────────────────────────

async function runTuiAsk(
  query: string,
  opts?: { model?: string; think?: string },
): Promise<void> {
  // Always use direct mode for --ask (skip socket)
  const { runTuiDirect } = await import('./tui-direct.js');
  const args = ['--query', query];
  if (opts?.model) args.push('--model', opts.model);
  if (opts?.think) args.push('--think', opts.think);
  return runTuiDirect(args);
}
