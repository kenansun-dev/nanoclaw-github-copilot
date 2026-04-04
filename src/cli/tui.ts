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

  // Ctrl+C
  process.on('SIGINT', () => {
    if (waitingForReply) {
      stopSpinner();
      waitingForReply = false;
      console.log('\n⏹ Cancelled.\n');
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
    socket.write(JSON.stringify({ type: 'message', text: trimmed }) + '\n');
  }
}

function connectToService(sockPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(sockPath, () => {
      resolve(socket);
    });
    socket.on('error', reject);
    // Timeout after 2 seconds
    socket.setTimeout(2000, () => {
      socket.destroy();
      reject(new Error('Connection timeout'));
    });
  });
}
