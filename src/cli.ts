#!/usr/bin/env node

/**
 * nanoclaw CLI — entry point
 *
 * Usage: nanoclaw <command> [options]
 */

// IMPORTANT: must run before any import that pulls in ./log.js, because
// src/log.ts captures `threshold` from process.env.LOG_LEVEL at module
// load time. Short-lived CLI commands (anything except daemon `start` /
// `start-foreground` / interactive `tui`) default to LOG_LEVEL=warn so
// host-runner.killAllAgentPids() and friends don't spew INFO lines onto
// the user's terminal stdout. User-set LOG_LEVEL always wins.
// Regression fixed 2026-05-09 (kenan, Windows `nanoclaw stop`).
{
  const _argv = process.argv.slice(2);
  let _ci = 0;
  while (_ci < _argv.length) {
    const a = _argv[_ci];
    if (a === '--workspace' && _argv[_ci + 1]) {
      _ci += 2;
      continue;
    }
    if (a === '--help' || a === '-h' || a === '--version' || a === '-v') {
      _ci += 1;
      continue;
    }
    break;
  }
  const _cmd = _argv[_ci];
  const NOISY_DAEMON = new Set(['start', 'start-foreground', 'dev', 'tui']);
  if (!process.env.LOG_LEVEL && _cmd && !NOISY_DAEMON.has(_cmd)) {
    process.env.LOG_LEVEL = 'warn';
  }
}

import { resolve, dirname, join } from 'path';
import path from 'path';
import { fileURLToPath } from 'url';
import fs, { existsSync } from 'fs';
import os from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Parse global options
let workspaceOverride: string | undefined;
const args = process.argv.slice(2);
const globalArgs: string[] = [];
const cmdArgs: string[] = [];

let i = 0;
while (i < args.length) {
  if (args[i] === '--workspace' && args[i + 1]) {
    workspaceOverride = args[i + 1];
    i += 2;
  } else if (args[i] === '--help' || args[i] === '-h') {
    globalArgs.push(args[i]);
    i++;
  } else if (args[i] === '--version' || args[i] === '-v') {
    globalArgs.push(args[i]);
    i++;
  } else {
    break;
  }
}

// Remaining args: command + command args
const command = args[i];
const commandArgs = args.slice(i + 1);

if (workspaceOverride) {
  process.env.NANOCLAW_WORKSPACE = workspaceOverride;
}

// Disable logger console output for CLI commands (logger writes to file only).
// Daemon mode (start, start-foreground) and TUI keep console output enabled.
const daemonCommands = new Set(['start', 'start-foreground', 'tui']);
if (!daemonCommands.has(command || '')) {
  const { setConsoleOutput } = await import('./log-extensions.js');
  setConsoleOutput(false);
}

// Version
if (globalArgs.includes('--version') || globalArgs.includes('-v')) {
  try {
    const pkg = JSON.parse((await import('fs')).readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'));
    console.log(`nanoclaw v${pkg.version}`);
  } catch {
    console.log('nanoclaw (unknown version)');
  }
  process.exit(0);
}

// Help
if (!command || globalArgs.includes('--help') || globalArgs.includes('-h')) {
  printHelp();
  process.exit(0);
}

// Route commands
try {
  switch (command) {
    case 'init':
      await runInit(commandArgs);
      break;
    case 'doctor':
      await runDoctor(commandArgs);
      break;
    case 'start':
      await runService('start');
      break;
    case 'stop':
      await runService('stop');
      break;
    case 'restart':
      await runService('restart');
      break;
    case 'dev':
      await runDev();
      break;
    case 'status':
      await runService('status');
      break;
    case 'logs':
      await runLogs(commandArgs);
      break;
    case 'loglevel': {
      const { runLogLevel } = await import('./cli/loglevel.js');
      await runLogLevel(commandArgs);
      break;
    }
    case 'reload': {
      const { runReload } = await import('./cli/reload.js');
      await runReload(commandArgs);
      break;
    }
    case 'config':
      await runConfig(commandArgs);
      break;
    case 'provider':
      await runProvider(commandArgs);
      break;
    case 'channel':
      await runChannel(commandArgs);
      break;
    case 'addon': {
      const { runAddonCommand } = await import('./cli/addon.js');
      await runAddonCommand(commandArgs);
      break;
    }
    case 'plugin': {
      const { runPluginCommand } = await import('./cli/plugin.js');
      await runPluginCommand(commandArgs);
      break;
    }

    case 'chat':
      await runChat(commandArgs);
      break;
    case 'tui': {
      const { runTui } = await import('./cli/tui.js');
      await runTui(commandArgs);
      break;
    }
    case 'pair': {
      const { runPair } = await import('./cli/pair.js');
      await runPair(commandArgs);
      break;
    }
    case 'task':
    case 'tasks': {
      const { runTaskCommand } = await import('./cli/task.js');
      await runTaskCommand(commandArgs);
      break;
    }
    case 'mcp':
      await runMcp(commandArgs);
      break;
    case 'service': {
      const { runServiceCommand } = await import('./cli/service.js');
      await runServiceCommand(args);
      break;
    }
    case 'sandbox':
      await runSandbox(commandArgs);
      break;
    case 'update':
      await runUpdateCmd(commandArgs);
      break;
    case 'rollback': {
      const { runRollback } = await import('./cli/rollback.js');
      await runRollback(commandArgs);
      break;
    }
    default:
      console.error(`Unknown command: ${command}`);
      console.error('Run "nanoclaw --help" for usage.');
      process.exit(1);
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}

// === Command implementations ===

async function runInit(args: string[]) {
  const { initWorkspace } = await import('./cli/init.js');
  await initWorkspace(PROJECT_ROOT, args);
}

async function runDoctor(_args: string[]) {
  // Reconcile first so doctor's main-chat singleton check sees DB-only
  // chats too (otherwise we miss the very mount-collision case the check
  // exists to catch).
  try {
    const { initDatabase } = await import('./db.js');
    initDatabase();
    const { reconcileChatRegistry } = await import('./chat-reconcile.js');
    reconcileChatRegistry();
  } catch {
    // best effort — doctor still runs and will report the underlying issue
  }
  const { runDoctor, formatDoctorResults } = await import('./doctor.js');
  const results = runDoctor();
  console.log(formatDoctorResults(results));
}

async function runService(action: string) {
  const { resolveWorkspace, paths: wsPaths } = await import('./workspace.js');
  const ws = resolveWorkspace();
  const os = await import('os');
  const fs = await import('fs');
  const { execSync, spawn } = await import('child_process');

  // B.5 + 2026-05-09 followup: file logging is daily-rotated
  // (`nanoclaw-YYYY-MM-DD.log`), driven by the in-process sink in
  // `log-file-sink.ts`. Use the workspace `paths.logFile` getter so
  // the start-time crash check reads the same file the sink writes to.
  const SERVICE_NAME = 'nanoclaw';
  const pidFile = join(ws, 'state', 'nanoclaw.pid');
  const logFile = wsPaths.logFile;
  const entryPoint = join(PROJECT_ROOT, 'dist', 'index.js');

  // --- Detect service backend ---
  const hasSystemd = (() => {
    if (process.platform !== 'linux') return false;
    const serviceFile = join(os.homedir(), '.config', 'systemd', 'user', `${SERVICE_NAME}.service`);
    return existsSync(serviceFile);
  })();

  const hasSchedTask = (() => {
    if (process.platform !== 'win32') return false;
    try {
      execSync(`schtasks /Query /TN "${SERVICE_NAME}" /FO CSV /NH`, {
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  })();

  const hasWindowsAutoStart = (() => {
    if (process.platform !== 'win32') return false;
    try {
      execSync('reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "nanoclaw"', { stdio: 'pipe' });
      return true;
    } catch {
      const startupDir = join(
        os.homedir(),
        'AppData',
        'Roaming',
        'Microsoft',
        'Windows',
        'Start Menu',
        'Programs',
        'Startup',
      );
      return existsSync(join(startupDir, 'nanoclaw.vbs')) || existsSync(join(startupDir, 'nanoclaw.bat'));
    }
  })();

  const useSystemd = hasSystemd && action !== 'dev';

  // --- Windows kill helper ---
  const killProcess = (pid: number) => {
    if (process.platform === 'win32') {
      try {
        // /T kills the process tree (including child agent-runner processes)
        execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'pipe' });
      } catch {
        /* */
      }
    } else {
      try {
        // Kill the process group (negative PID) to kill children too
        process.kill(-pid, 'SIGTERM');
      } catch {
        try {
          process.kill(pid, 'SIGTERM');
        } catch {
          /* */
        }
      }
    }
  };

  switch (action) {
    case 'start': {
      if (useSystemd) {
        try {
          execSync(`systemctl --user start ${SERVICE_NAME}`, { stdio: 'pipe' });
          // Wait and check
          await new Promise((r) => setTimeout(r, 2000));
          const status = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          console.log(`Started via systemd (${status})`);
          console.log(`Logs: journalctl --user -u ${SERVICE_NAME} -f`);
        } catch (err: any) {
          console.error('systemd start failed. Falling back to direct start.');
          await startDirect();
        }
        return;
      }
      if (hasSchedTask) {
        try {
          execSync(`schtasks /Run /TN "${SERVICE_NAME}"`, { stdio: 'pipe' });
          console.log('Started via Scheduled Task');
          return;
        } catch {
          /* fall through to direct */
        }
      }
      // Start devtunnel if Teams is enabled and a nanoclaw tunnel exists
      try {
        const { loadConfig: loadCfg } = await import('./config-loader.js');
        const cfg = loadCfg();
        if (cfg.channels?.teams?.enabled) {
          const { execSync: ex, spawn: sp } = await import('child_process');
          try {
            // Find nanoclaw tunnel
            const listOut = ex('devtunnel list', {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
              timeout: 10000,
            });
            const tunnelLine = listOut.split('\n').find((l: string) => l.toLowerCase().includes('nanoclaw'));
            if (tunnelLine) {
              const idMatch = tunnelLine.match(/([a-zA-Z0-9._-]+)/);
              if (idMatch) {
                const tid = idMatch[1];
                // Check if tunnel is already hosting
                const showOut = ex(`devtunnel show ${tid}`, {
                  encoding: 'utf-8',
                  stdio: ['pipe', 'pipe', 'pipe'],
                  timeout: 10000,
                });
                const hosting = showOut.includes('Host connections');
                const hostCount = showOut.match(/Host connections\s*:\s*(\d+)/);
                if (!hostCount || hostCount[1] === '0') {
                  console.log(`Starting devtunnel: ${tid}...`);
                  const dtProc = sp('devtunnel', ['host', tid, '--allow-anonymous'], {
                    detached: true,
                    stdio: 'ignore',
                  });
                  dtProc.unref();
                  // Save PID so nanoclaw stop can kill it
                  try {
                    const dtPidFile = join(ws, 'devtunnel.pid');
                    fs.writeFileSync(dtPidFile, String(dtProc.pid));
                  } catch {
                    /* */
                  }
                  console.log(`DevTunnel started (pid: ${dtProc.pid})`);
                } else {
                  console.log(`DevTunnel already hosting: ${tid}`);
                }
              }
            }
          } catch {
            // devtunnel not installed or not logged in — skip silently
          }
        }
      } catch {
        /* config not available */
      }
      await startDirect();
      break;
    }
    case 'stop': {
      if (useSystemd) {
        try {
          execSync(`systemctl --user stop ${SERVICE_NAME}`, { stdio: 'pipe' });
          console.log('Stopped via systemd');
        } catch {
          console.log('systemd stop failed');
        }
        // Also kill any lingering agent child processes
        try {
          const { killAllAgentPids } = await import('./host-runner.js');
          await killAllAgentPids();
        } catch {
          /* */
        }
        return;
      }
      // PID fallback
      if (!existsSync(pidFile)) {
        // Daemon pidfile gone, but there may still be orphaned agent
        // children whose root pid never got unregistered (e.g. if the
        // daemon crashed instead of exiting cleanly). Kenan, 2026-04-21:
        // 'nanoclaw stop' 就算检测到没在跑，也可以把相应的进程再 stop 一遍。
        try {
          const { killAllAgentPids } = await import('./host-runner.js');
          await killAllAgentPids();
        } catch (err: any) {
          console.log(`[stop] killAllAgentPids failed: ${err?.message ?? err}`);
        }
        // Also try to kill devtunnel if we started it
        try {
          const dtPidFile = join(ws, 'devtunnel.pid');
          if (existsSync(dtPidFile)) {
            const dtPid = parseInt(fs.readFileSync(dtPidFile, 'utf-8').trim());
            try {
              killProcess(dtPid);
              console.log(`[stop] cleaned up orphaned devtunnel (pid: ${dtPid})`);
            } catch {
              /* already dead */
            }
            fs.unlinkSync(dtPidFile);
          }
        } catch {
          /* */
        }
        console.log('Not running (attempted cleanup of any tracked child pids)');
        return;
      }
      const pid = fs.readFileSync(pidFile, 'utf-8').trim();
      const pidNum = parseInt(pid);
      // Kill child agent processes first
      try {
        const { killAllAgentPids } = await import('./host-runner.js');
        await killAllAgentPids();
      } catch {
        /* */
      }
      killProcess(pidNum);
      // Wait for process to release file locks (important on Windows)
      const stopStart = Date.now();
      while (Date.now() - stopStart < 8000) {
        try {
          process.kill(pidNum, 0);
          await new Promise((r) => setTimeout(r, 300));
        } catch {
          break; // Process is gone
        }
      }
      // Force kill if still alive
      try {
        process.kill(pidNum, 0);
        killProcess(pidNum);
      } catch {
        /* */
      }
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* */
      }
      console.log(`Stopped (pid: ${pid})`);
      // Also stop devtunnel if we started it
      try {
        const dtPidFile = join(ws, 'devtunnel.pid');
        if (existsSync(dtPidFile)) {
          const dtPid = parseInt(fs.readFileSync(dtPidFile, 'utf-8').trim());
          try {
            killProcess(dtPid);
            console.log(`Stopped devtunnel (pid: ${dtPid})`);
          } catch {
            /* already dead */
          }
          fs.unlinkSync(dtPidFile);
        }
      } catch {
        /* */
      }
      break;
    }
    case 'restart': {
      if (useSystemd) {
        try {
          execSync(`systemctl --user restart ${SERVICE_NAME}`, {
            stdio: 'pipe',
          });
          await new Promise((r) => setTimeout(r, 2000));
          const status = execSync(`systemctl --user is-active ${SERVICE_NAME}`, {
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
          }).trim();
          console.log(`Restarted via systemd (${status})`);
        } catch {
          console.error('systemd restart failed. Trying stop + start...');
          await runService('stop');
          await new Promise((r) => setTimeout(r, 1000));
          await runService('start');
        }
        return;
      }
      await runService('stop');
      await new Promise((r) => setTimeout(r, 1000));
      await runService('start');
      break;
    }
    case 'status': {
      // Status formatting was extracted to ./cli/status-text.ts so the
      // slash-command handler can reuse it without bouncing through the
      // LLM. See that module for the rules.
      const { getStatusText } = await import('./cli/status-text.js');
      console.log(await getStatusText());
      break;
    }
  }

  // --- Direct start (PID mode fallback) ---
  async function startDirect() {
    if (existsSync(pidFile)) {
      const pid = fs.readFileSync(pidFile, 'utf-8').trim();
      try {
        process.kill(parseInt(pid), 0);
        console.log(`Already running (pid: ${pid})`);
        return;
      } catch {
        /* stale */
      }
    }
    fs.mkdirSync(dirname(logFile), { recursive: true });
    fs.mkdirSync(dirname(pidFile), { recursive: true });

    // Load workspace .env into our env BEFORE spawning so the child
    // inherits TELEGRAM_BOT_TOKEN, COPILOT_GITHUB_TOKEN, MSTEAMS_*, etc.
    // Fix 2026-05-06: detached daemon was starting with empty env
    // because no shell sourced ~/.nanoclaw/.env.
    {
      const { loadWorkspaceEnv } = await import('./env-loader.js');
      loadWorkspaceEnv(ws);
    }
    const child = spawn('node', [entryPoint], {
      detached: true,
      stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
      cwd: ws, // workspace, not PROJECT_ROOT
      env: { ...process.env, NANOCLAW_WORKSPACE: ws },
    });
    fs.writeFileSync(pidFile, String(child.pid));
    child.unref();
    console.log(`Started (pid: ${child.pid})`);
    console.log(`Logs: ${logFile}`);

    // Check only NEW log lines (after start time)
    const startTime = Date.now();
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const content = fs.readFileSync(logFile, 'utf-8');
      const lines = content.split('\n');
      // Only check lines from the last few seconds
      for (const line of lines.slice(-30)) {
        // Parse pino timestamp if available
        const tsMatch = line.match(/\["(\d{2}:\d{2}:\d{2})/);
        if (line.includes('FATAL') || line.includes('Failed to start')) {
          console.error(line.replace(/\x1b\[[0-9;]*m/g, '').trim());
        }
      }
      try {
        process.kill(child.pid!, 0);
      } catch {
        console.error('Process exited shortly after start. Run: nanoclaw logs');
      }
    } catch {
      /* log not ready */
    }
  }
}

async function runDev() {
  // Run in foreground — just exec the main entry point
  const { resolveWorkspace } = await import('./workspace.js');
  const ws = resolveWorkspace();
  process.env.NANOCLAW_WORKSPACE = ws;
  // Load .env before importing index.js so config/channels see the env.
  const { loadWorkspaceEnv } = await import('./env-loader.js');
  loadWorkspaceEnv(ws);
  await import('./index.js');
}

async function runLogs(args: string[]) {
  const { resolveWorkspace } = await import('./workspace.js');
  const { paths: wsPaths } = await import('./workspace.js');
  // B.5 + 2026-05-09 followup: tail today's daily-rotated file, with
  // legacy `nanoclaw.log` fallback for older v1 workspaces.
  let logFile = wsPaths.logFile;
  const fs = await import('fs');
  if (!fs.existsSync(logFile)) {
    const legacy = join(resolveWorkspace(), 'logs', 'nanoclaw.log');
    if (fs.existsSync(legacy)) logFile = legacy;
  }
  const follow = args.includes('-f') || args.includes('--follow');

  if (!fs.existsSync(logFile)) {
    console.log('No logs found');
    return;
  }

  if (follow) {
    // Cross-platform tail -f using Node.js
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines.slice(-20)) {
      if (line) console.log(line);
    }

    let pos = fs.statSync(logFile).size;

    const watcher = () => {
      const stat = fs.statSync(logFile);
      if (stat.size > pos) {
        const stream = fs.createReadStream(logFile, {
          start: pos,
          encoding: 'utf-8',
        });
        stream.on('data', (chunk) => process.stdout.write(String(chunk)));
        pos = stat.size;
      } else if (stat.size < pos) {
        pos = 0; // log rotated
      }
    };

    fs.watchFile(logFile, { interval: 500 }, watcher);

    const cleanup = () => {
      fs.unwatchFile(logFile, watcher);
      process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
  } else {
    // Show last 50 lines
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.split('\n');
    const last50 = lines.slice(-51, -1); // -1 to skip trailing empty
    for (const line of last50) {
      console.log(line);
    }
  }
}

async function runConfig(args: string[]) {
  const sub = args[0];
  const { loadConfig } = await import('./config-loader.js');
  if (sub === 'get') {
    const config = await loadConfig();
    const key = args[1];
    if (key) {
      const val = key.split('.').reduce((obj: any, k) => obj?.[k], config);
      console.log(JSON.stringify(val, null, 2));
    } else {
      console.log(JSON.stringify(config, null, 2));
    }
  } else if (sub === 'set') {
    const key2 = args[1];
    const val2 = args[2];
    if (!key2 || val2 === undefined) {
      console.log('Usage: nanoclaw config set <key> <value>');
      return;
    }
    const { configSet } = await import('./cli/config-set.js');
    configSet(key2, val2);
    console.log('Config updated.');
  } else {
    console.log('Usage: nanoclaw config <get|set> [key] [value]');
  }
}

async function runProvider(args: string[]) {
  const sub = args[0];
  switch (sub) {
    case 'login': {
      // Detect provider from config if not specified
      let provider = args[1];
      if (!provider) {
        try {
          const { loadConfig } = await import('./config-loader.js');
          const cfg = loadConfig();
          const agent = cfg.agents?.defaults as any;
          provider = agent?.provider || (agent?.model?.includes('/') ? agent.model.split('/')[0] : 'github-copilot');
        } catch {
          /* */
        }
        provider = provider || 'github-copilot';
      }

      if (provider === 'github-copilot') {
        console.log('Starting GitHub Copilot login (device code flow)...');
        try {
          const { execSync } = await import('child_process');
          execSync('copilot login', { stdio: 'inherit', timeout: 120000 });
          console.log('Login successful.');
        } catch {
          console.error('Login failed. Make sure copilot CLI is installed: npm install -g @github/copilot');
        }
      } else if (provider === 'claude' || provider === 'anthropic') {
        console.log('Starting Claude Code login...');
        try {
          const { execSync } = await import('child_process');
          execSync('claude login', { stdio: 'inherit', timeout: 300000 });
          console.log('Login successful.');
        } catch {
          console.error(
            'Login failed. Make sure Claude Code CLI is installed: npm install -g @anthropic-ai/claude-code',
          );
        }
      } else {
        console.log(`Unknown provider: ${provider}`);
        console.log('Supported: github-copilot, claude');
      }
      break;
    }
    case 'status': {
      const { runDoctor: _doc, formatDoctorResults: _fmt } = await import('./doctor.js');
      // Quick auth check
      const os = await import('os');
      const fs = await import('fs');
      const path = await import('path');
      const profilePath = path.join(os.homedir(), '.openclaw/agents/main/agent/auth-profiles.json');
      if (process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN || process.env.GITHUB_TOKEN) {
        console.log('✅ github-copilot: authenticated (env token)');
      } else if (fs.existsSync(profilePath)) {
        try {
          const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          const hasGhc = Object.values(profiles.profiles || {}).some(
            (p: any) => p.provider === 'github-copilot' && p.token,
          );
          console.log(
            hasGhc ? '✅ github-copilot: authenticated (OpenClaw profile)' : '❌ github-copilot: not authenticated',
          );
        } catch {
          console.log('❌ github-copilot: not authenticated');
        }
      } else {
        console.log('❌ github-copilot: not authenticated — run: nanoclaw provider login');
      }
      break;
    }
    case 'logout':
      console.log('Provider logout: clearing cached credentials...');
      // Future: clear cached tokens
      console.log('Done.');
      break;
    default:
      console.log('Usage: nanoclaw provider <login|status|logout> [name]');
  }
}

async function runChannel(args: string[]) {
  const sub = args[0];
  switch (sub) {
    case 'list': {
      const { runChannelCommand } = await import('./cli/channel.js');
      await runChannelCommand(['list']);
      break;
    }
    case 'add': {
      const { runChannelCommand } = await import('./cli/channel.js');
      await runChannelCommand(['add', ...args.slice(1)]);
      break;
    }
    case 'remove': {
      const { runChannelCommand } = await import('./cli/channel.js');
      await runChannelCommand(['remove', args[1]]);
      break;
    }
    case 'test':
      if (!args[1]) {
        console.log('Usage: nanoclaw channel test <name>');
        break;
      }
      const { channelTest } = await import('./cli/channel-commands.js');
      await channelTest(args[1]);
      break;
    default:
      console.log('Usage: nanoclaw channel <list|add|remove|test> [name]');
  }
}

async function runChat(args: string[]) {
  const sub = args[0];
  const { initDatabase } = await import('./db.js');
  initDatabase();

  // Reconcile DB ↔ config.chats so `chat list`, `chat set-main`, etc. all
  // see the same picture. Cheap (idempotent) and prevents the "DB has 8
  // chats but config.chats is empty" deploy hazard.
  if (sub !== 'reconcile') {
    const { reconcileChatRegistry } = await import('./chat-reconcile.js');
    reconcileChatRegistry();
  }

  switch (sub) {
    case 'reconcile': {
      const { reconcileChatRegistry } = await import('./chat-reconcile.js');
      const r = reconcileChatRegistry();
      console.log(
        `Reconciled: added ${r.added.length}, deduped main on ${r.dedupedMains.length}, mirrored to DB ${r.mirroredToDb.length}.`,
      );
      if (r.added.length > 0) console.log('  added: ' + r.added.join(', '));
      if (r.dedupedMains.length > 0) console.log('  cleared isMain: ' + r.dedupedMains.join(', '));
      if (r.keptMain) console.log('  kept main: ' + r.keptMain);
      break;
    }
    case 'list': {
      const { listChats } = await import('./chat-manager.js');
      const chats = listChats();
      if (chats.length === 0) {
        console.log('No registered chats. Add one with: nanoclaw chat add <jid> <name>');
      } else {
        console.log('  ID  | CHANNEL    | JID                       | NAME');
        console.log('  ----+------------+---------------------------+------');
        for (const c of chats) {
          const idCol = String(c.id ?? '?').padStart(3);
          const chCol = (c.channel || '?').padEnd(10);
          const jidCol = c.jid.padEnd(25).slice(0, 25);
          const main = c.isMain ? ' [main]' : '';
          console.log(`  ${idCol} | ${chCol} | ${jidCol} | ${c.name}${main}`);
        }
      }
      break;
    }
    case 'pending': {
      const { listPendingChats } = await import('./chat-manager.js');
      const pending = listPendingChats();
      if (pending.length === 0) {
        console.log('No pending chats.');
      } else {
        for (const c of pending) {
          console.log(`  ${c.channel || '?'} | ${c.jid} | ${c.name}`);
        }
      }
      break;
    }
    case 'add': {
      const jid = args[1];
      const name = args[2] || 'unnamed';
      const isMain = args.includes('--main');
      if (!jid) {
        console.error('Usage: nanoclaw chat add <jid> <name> [--main]');
        process.exit(1);
      }
      const { addChat } = await import('./chat-manager.js');
      addChat(jid, name, { isMain });
      console.log(`Chat registered: ${jid} (${name})${isMain ? ' [main]' : ''}`);
      break;
    }
    case 'add': {
      const jid = args[1];
      const name = args[2] || 'unnamed';
      const isMain = args.includes('--main');
      if (!jid) {
        console.error('Usage: nanoclaw chat add <jid> <name> [--main]');
        process.exit(1);
      }
      const { addChat } = await import('./chat-manager.js');
      const { id } = addChat(jid, name, { isMain });
      console.log(`Chat registered: #${id} ${jid} (${name})${isMain ? ' [main]' : ''}`);
      break;
    }
    case 'set-main': {
      const handle = args[1];
      if (!handle) {
        console.error('Usage: nanoclaw chat set-main <id-or-jid>');
        process.exit(1);
      }
      const { loadConfig, resolveChatHandle } = await import('./config-loader.js');
      const { setMainChat } = await import('./chat-manager.js');
      const config = loadConfig();
      const jid = resolveChatHandle(config, handle);
      if (!jid) {
        console.error(`No chat matches "${handle}". Run \`nanoclaw chat list\` to see ids.`);
        process.exit(1);
      }
      setMainChat(jid);
      const entry = config.chats[jid];
      console.log(`Main chat set: #${entry?.id ?? '?'} ${jid} (${entry?.name ?? '?'})`);
      break;
    }
    case 'unset-main': {
      const { setMainChat } = await import('./chat-manager.js');
      setMainChat(null);
      console.log('Main chat cleared.');
      break;
    }
    case 'remove': {
      const handle = args[1];
      if (!handle) {
        console.error('Usage: nanoclaw chat remove <id-or-jid>');
        process.exit(1);
      }
      const { loadConfig, resolveChatHandle } = await import('./config-loader.js');
      const { removeChat } = await import('./chat-manager.js');
      const config = loadConfig();
      const jid = resolveChatHandle(config, handle) ?? handle;
      const removed = removeChat(jid);
      console.log(removed ? `Chat removed: ${jid}` : `Chat not found: ${handle}`);
      break;
    }
    default:
      console.log('Usage: nanoclaw chat <list|pending|add|remove|set-main|unset-main> [args]');
  }
}

async function runSandbox(args: string[]) {
  const sub = args[0];
  switch (sub) {
    case 'build': {
      const { loadConfig } = await import('./config-loader.js');
      const { isGHCProvider } = await import('./config-extensions.js');
      const { execSync } = await import('child_process');
      const path = await import('path');

      const config = loadConfig();
      const isGHC = isGHCProvider();
      // Find package root — works for both npm global install and local dev
      const { fileURLToPath } = await import('url');
      const __filename = fileURLToPath(import.meta.url);
      const __dirname = path.dirname(__filename);
      const projectRoot = path.resolve(__dirname, '..');

      // Determine which Dockerfile and image to build
      const dockerfile = isGHC ? 'Dockerfile.ghc' : 'Dockerfile';
      const imageName = isGHC ? 'nanoclaw-agent-ghc:latest' : config.sandbox?.image || 'nanoclaw-agent:latest';
      const contextDir = path.join(projectRoot, 'container');
      const dockerfilePath = path.join(contextDir, dockerfile);

      const fs = await import('fs');
      if (!fs.existsSync(dockerfilePath)) {
        console.error(`❌ Dockerfile not found: ${dockerfilePath}`);
        console.error(`   Are you in the nanoclaw project directory?`);
        process.exit(1);
      }

      console.log(`Building ${isGHC ? 'GHC' : 'CC'} agent image...`);
      console.log(`  Dockerfile: ${dockerfile}`);
      console.log(`  Image: ${imageName}`);
      console.log(`  Context: ${contextDir}`);
      console.log('');

      try {
        execSync(`docker build -t ${imageName} -f ${dockerfilePath} ${contextDir}`, {
          stdio: 'inherit',
          timeout: 600_000,
        });
        console.log(`\n✅ Image built: ${imageName}`);
      } catch (err: any) {
        console.error(`\n❌ Build failed. Is Docker running?`);
        console.error(`   Run: docker info`);
        process.exit(1);
      }
      break;
    }
    case 'status': {
      const { execSync } = await import('child_process');
      try {
        const images = execSync(
          'docker images nanoclaw-agent* --format "{{.Repository}}:{{.Tag}} {{.Size}} {{.CreatedAt}}"',
          { encoding: 'utf-8' },
        ).trim();
        if (images) {
          console.log('Agent images:');
          console.log(images);
        } else {
          console.log('No agent images found. Run: nanoclaw sandbox build');
        }
        console.log('');
        const containers = execSync(
          'docker ps --filter "name=nanoclaw-" --format "{{.Names}} {{.Image}} {{.Status}}"',
          { encoding: 'utf-8' },
        ).trim();
        if (containers) {
          console.log('Running containers:');
          console.log(containers);
        } else {
          console.log('No running containers.');
        }
      } catch {
        console.error('Docker not available. Run: docker info');
      }
      break;
    }
    default:
      console.log('Usage: nanoclaw sandbox <build|status>');
  }
}

async function runUpdateCmd(args: string[]) {
  const { runUpdate } = await import('./cli/update.js');
  await runUpdate(args);
}

function printHelp() {
  console.log(`
nanoclaw — AI assistant that runs agents in secure containers

Usage: nanoclaw <command> [options]

Setup
  init                              Initialize workspace
  doctor                            Check dependencies & config health
  update                            Update to latest version
                                    --package <tgz>     Install local tgz
                                    --backup-dir <path> Override backup location
                                    --no-backup         Skip workspace snapshot (DANGEROUS)
  rollback                          Restore previous binary + workspace snapshot
                                    --backup-dir <path> Pick backup root
                                    --to <snapshot>     Restore a specific snapshot
                                    --no-keep-current   Delete current ws (default: side-stash)
                                    --no-binary         Restore workspace only, skip binary reinstall
                                    --dry-run           Print plan only

Service
  start                             Start nanoclaw (background)
  stop                              Stop nanoclaw
  restart                           Restart nanoclaw
  dev                               Start in foreground (debug)
  status                            Show service + workspace status
  logs [-f]                         View logs
  loglevel [<level>]                Show or change log level (live, no restart)
  reload                            Ask running daemon to re-read nanoclaw.json

Config
  config get [key]                  Show config
  config set <key> <value>          Update config

Providers
  provider login <name>             Login to a provider
  provider status [name]            Show auth status
  provider logout <name>            Remove credentials

Channels
  channel list                      Show configured channels
  channel test <name>               Test a channel connection

Chats
  pair [<jid>] [--name <n>] [--main] Pair a new chat
  chat list                         List registered chats
  chat pending                      Show unregistered chats
  chat add <jid> --name <name>      Register a chat
  chat remove <jid>                 Unregister a chat

Interactive
  tui                               Interactive terminal chat

Tasks
  task list                         List scheduled tasks (defaults to all chats)
       --chat <jid>                 Filter by chat_jid
       --status <s>                 Filter by status (active|paused|completed)
       --json                       Emit JSON
  task info <id>                    Show task details + recent run logs

Sandbox

  sandbox build                     Build agent container image
  sandbox status                    Show sandbox runtime info

Tunnel

MCP
  mcp list                          List configured MCP servers
  mcp add <name> <url>              Add remote MCP server
  mcp remove <name>                 Remove MCP server

Global Options
  --workspace <path>                Workspace (default: ~/.nanoclaw)
  --help                            Show help
  --version                         Show version
`);
}

async function runMcp(args: string[]) {
  const sub = args[0];

  switch (sub) {
    case undefined:
    case 'list': {
      // Parity with `claude mcp` / `gh copilot mcp list` and the `/mcp`
      // slash command. File-only read, <50ms.
      const { getMcpText } = await import('./cli/mcp-text.js');
      const text = await getMcpText({ codeFence: false }); // CLI: no code fence
      console.log(text);
      break;
    }
    case 'add': {
      const name = args[1];
      const url = args[2];
      if (!name || !url) {
        console.error('Usage: nanoclaw mcp add <name> <url>');
        process.exit(1);
      }
      // Write to nanoclaw.json (single source of truth)
      const { loadConfig, saveConfig } = await import('./config-loader.js');
      const cfg = loadConfig();
      cfg.mcp.servers[name] = { type: 'http', url, tools: ['*'] };
      saveConfig(cfg);
      console.log(`Added MCP server: ${name} (saved to nanoclaw.json)`);
      // Ask running daemon to reload so the next agent turn sees the new
      // server without requiring `nanoclaw restart`.
      try {
        const { signalReload } = await import('./daemon-signal.js');
        const r = signalReload();
        if (r.delivered) {
          console.log(
            r.method === 'trigger-file'
              ? '  → reload trigger written; daemon will pick it up shortly.'
              : '  → daemon reloaded (live, no restart needed).',
          );
        } else if (r.noDaemon) {
          console.log('  → daemon not running; will be picked up on next start.');
        } else {
          console.log(`  → reload signal failed (${r.error || 'unknown'}); run \`nanoclaw restart\` to apply.`);
        }
      } catch {
        /* reload is best-effort */
      }
      break;
    }
    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: nanoclaw mcp remove <name>');
        process.exit(1);
      }
      // Remove from nanoclaw.json
      const { loadConfig: lc, saveConfig: sc } = await import('./config-loader.js');
      const c = lc();
      delete c.mcp.servers[name];
      sc(c);
      console.log(`Removed MCP server: ${name} (saved to nanoclaw.json)`);
      // Ask running daemon to reload so the removed server is dropped from
      // the next agent turn's mcp.json.
      try {
        const { signalReload } = await import('./daemon-signal.js');
        const r = signalReload();
        if (r.delivered) {
          console.log(
            r.method === 'trigger-file'
              ? '  → reload trigger written; daemon will pick it up shortly.'
              : '  → daemon reloaded (live, no restart needed).',
          );
        } else if (r.noDaemon) {
          console.log('  → daemon not running; will be picked up on next start.');
        }
      } catch {
        /* reload is best-effort */
      }
      break;
    }
    default:
      console.log(`Usage: nanoclaw mcp <list|add|remove> [args]

Commands:
  list                  List configured MCP servers
  add <name> <url>      Add a remote MCP server
  remove <name>         Remove an MCP server`);
  }
}
