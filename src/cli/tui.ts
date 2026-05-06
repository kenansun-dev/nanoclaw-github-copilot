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

/**
 * Visual column width of a string. CJK wide chars take 2 columns.
 * Covers common East Asian ranges: CJK Unified Ideographs, Hangul, Hiragana,
 * Katakana, fullwidth forms. Approximation — doesn't handle zero-width,
 * combining marks, or variation selectors.
 */
function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0) || 0;
    if (
      (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
      (cp >= 0x2e80 && cp <= 0x303e) || // CJK Radicals / Kangxi
      (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana/Katakana/CJK Symbols
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
      (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul Syllables
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK Compatibility Forms
      (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth Forms
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x20000 && cp <= 0x2fffd) || // CJK Extensions B-F
      (cp >= 0x30000 && cp <= 0x3fffd)
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

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
  // Load workspace .env so TUI direct-mode (and any subprocess it spawns)
  // sees TELEGRAM_BOT_TOKEN / COPILOT_GITHUB_TOKEN / MSTEAMS_*. (2026-05-06 fix.)
  {
    const { loadWorkspaceEnv } = await import('../env-loader.js');
    loadWorkspaceEnv(ws);
  }
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
  let lastPartialLines = 0;
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
        // Clear previous partial output (multi-line aware)
        if (lastPartialLines > 0) {
          // Move cursor up and clear each line
          for (let i = 0; i < lastPartialLines; i++) {
            process.stdout.write('\x1b[A\x1b[K');
          }
        }
        process.stdout.write('\r\x1b[K');
        {
          const display = `\x1b[32m${currentAssistantName}>\x1b[0m ${msg.text}`;
          process.stdout.write(display);
          const cols = process.stdout.columns || 80;
          const stripped = display.replace(/\x1b\[[0-9;]*m/g, '');
          const logicalLines = stripped.split('\n');
          let visualLines = 0;
          for (const line of logicalLines) {
            visualLines += Math.max(1, Math.ceil(visualWidth(line) / cols));
          }
          lastPartialLines = Math.max(0, visualLines - 1);
        }
        break;

      case 'reply':
        stopSpinner();
        waitingForReply = false;
        // Clear previous partial output before final reply
        if (lastPartialLines > 0) {
          for (let i = 0; i < lastPartialLines; i++) {
            process.stdout.write('\x1b[A\x1b[K');
          }
        }
        process.stdout.write(
          `\r\x1b[K\x1b[32m${currentAssistantName}>\x1b[0m ${msg.text}\n\n`,
        );
        lastPartialLines = 0;
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
      rl.resume();
      console.log('\n⏹ Cancelled.\n');
      // Reset count after cancel so next single Ctrl-C exits cleanly
      setTimeout(() => {
        sigintCount = 0;
      }, 1000);
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
        saveConfig(cfg, 'tui', { command: '/think', level });
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
