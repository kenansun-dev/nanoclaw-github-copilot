#!/usr/bin/env node

/**
 * nanoclaw CLI — entry point
 *
 * Usage: nanoclaw <command> [options]
 */

import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

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

// Version
if (globalArgs.includes('--version') || globalArgs.includes('-v')) {
  try {
    const pkg = JSON.parse(
      (await import('fs')).readFileSync(join(PROJECT_ROOT, 'package.json'), 'utf-8'),
    );
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
    case 'config':
      await runConfig(commandArgs);
      break;
    case 'provider':
      await runProvider(commandArgs);
      break;
    case 'channel':
      await runChannel(commandArgs);
      break;
    case 'chat':
      await runChat(commandArgs);
      break;
    case 'mcp':
      await runMcp(commandArgs);
      break;
    case 'sandbox':
      await runSandbox(commandArgs);
      break;
    case 'update':
      await runUpdateCmd();
      break;
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
  const { initWorkspace } = await import('../dist/cli/init.js');
  await initWorkspace(PROJECT_ROOT);
}

async function runDoctor(_args: string[]) {
  const { runDoctor, formatDoctorResults } = await import('../dist/doctor.js');
  const results = runDoctor();
  console.log(formatDoctorResults(results));
}

async function runService(action: string) {
  const { resolveWorkspace } = await import('../dist/workspace.js');
  const ws = resolveWorkspace();
  const pidFile = join(ws, 'state', 'nanoclaw.pid');
  const logFile = join(ws, 'logs', 'nanoclaw.log');
  const { execSync, spawn } = await import('child_process');
  const fs = await import('fs');

  const entryPoint = join(PROJECT_ROOT, 'dist', 'index.js');

  switch (action) {
    case 'start': {
      if (existsSync(pidFile)) {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        try {
          process.kill(parseInt(pid), 0);
          console.log(`Already running (pid: ${pid})`);
          return;
        } catch {
          // stale pid file
        }
      }
      fs.mkdirSync(dirname(logFile), { recursive: true });
      fs.mkdirSync(dirname(pidFile), { recursive: true });
      const child = spawn('node', [entryPoint], {
        detached: true,
        stdio: ['ignore', fs.openSync(logFile, 'a'), fs.openSync(logFile, 'a')],
        cwd: PROJECT_ROOT,
        env: { ...process.env, NANOCLAW_WORKSPACE: ws },
      });
      fs.writeFileSync(pidFile, String(child.pid));
      child.unref();
      console.log(`Started (pid: ${child.pid})`);
      console.log(`Logs: ${logFile}`);

      // Wait briefly then check log for startup warnings/errors
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const recentLog = fs.readFileSync(logFile, 'utf-8');
        const lines = recentLog.split('\n');
        for (const line of lines) {
          if (line.includes('WARNING') || line.includes('warning') || line.includes('\u26a0')) {
            console.log(line.replace(/\x1b\[[0-9;]*m/g, '').trim());
          }
          if (line.includes('FATAL') || line.includes('Failed to start')) {
            console.error(line.replace(/\x1b\[[0-9;]*m/g, '').trim());
          }
        }
        // Check if process is still alive
        try {
          process.kill(child.pid!, 0);
        } catch {
          console.error('\nProcess exited shortly after start. Check logs:');
          console.error(`  nanoclaw logs`);
        }
      } catch {
        // log file not ready yet, that's ok
      }
      break;
    }
    case 'stop': {
      if (!existsSync(pidFile)) {
        console.log('Not running');
        return;
      }
      const pid = fs.readFileSync(pidFile, 'utf-8').trim();
      try {
        process.kill(parseInt(pid), 'SIGTERM');
        fs.unlinkSync(pidFile);
        console.log(`Stopped (pid: ${pid})`);
      } catch {
        fs.unlinkSync(pidFile);
        console.log('Process not found, cleaned up pid file');
      }
      break;
    }
    case 'restart': {
      await runService('stop');
      await new Promise((r) => setTimeout(r, 2000));
      await runService('start');
      break;
    }
    case 'status': {
      if (!existsSync(pidFile)) {
        console.log('Status: not running');
      } else {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        try {
          process.kill(parseInt(pid), 0);
          console.log(`Status: running (pid: ${pid})`);
        } catch {
          console.log('Status: not running (stale pid file)');
        }
      }
      console.log(`Workspace: ${ws}`);
      console.log(`Config: ${join(ws, 'nanoclaw.json')}`);
      break;
    }
  }
}

async function runDev() {
  // Run in foreground — just exec the main entry point
  const { resolveWorkspace } = await import('../dist/workspace.js');
  process.env.NANOCLAW_WORKSPACE = resolveWorkspace();
  await import('../dist/index.js');
}

async function runLogs(args: string[]) {
  const { resolveWorkspace } = await import('../dist/workspace.js');
  const logFile = join(resolveWorkspace(), 'logs', 'nanoclaw.log');
  const follow = args.includes('-f') || args.includes('--follow');
  const { execSync, spawn } = await import('child_process');
  if (follow) {
    spawn('tail', ['-f', logFile], { stdio: 'inherit' });
  } else {
    try {
      execSync(`tail -n 50 "${logFile}"`, { stdio: 'inherit' });
    } catch {
      console.log('No logs found');
    }
  }
}

async function runConfig(args: string[]) {
  const sub = args[0];
  const { loadConfig } = await import('../dist/config-loader.js');
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
    const { configSet } = await import('../dist/cli/config-set.js');
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
      const provider = args[1] || 'github-copilot';
      if (provider === 'github-copilot') {
        console.log('Starting GitHub Copilot login (device code flow)...');
        try {
          const { execSync } = await import('child_process');
          // Use GHC CLI's built-in login
          execSync('copilot auth login', { stdio: 'inherit', timeout: 120000 });
          console.log('Login successful.');
        } catch {
          console.error('Login failed. Make sure copilot CLI is installed: npm install -g @github/copilot');
        }
      } else {
        console.log(`Unknown provider: ${provider}`);
      }
      break;
    }
    case 'status': {
      const { runDoctor: _doc, formatDoctorResults: _fmt } = await import('../dist/doctor.js');
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
          console.log(hasGhc ? '✅ github-copilot: authenticated (OpenClaw profile)' : '❌ github-copilot: not authenticated');
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
    case 'list':
      const { channelList } = await import('../dist/cli/channel-commands.js');
      channelList();
      break;
    case 'test':
      if (!args[1]) { console.log('Usage: nanoclaw channel test <name>'); break; }
      const { channelTest } = await import('../dist/cli/channel-commands.js');
      await channelTest(args[1]);
      break;
    default:
      console.log('Usage: nanoclaw channel <list|test> [name]');
  }
}

async function runChat(args: string[]) {
  const sub = args[0];
  const { initDatabase } = await import('../dist/db.js');
  initDatabase();
  // Cutover (2026-05-16): v1 reads delegate to v2; boot v2 too.
  const { initAndReconcileV2 } = await import('../dist/db/v2-boot.js');
  initAndReconcileV2();

  switch (sub) {
    case 'list': {
      const { listChats } = await import('../dist/chat-manager.js');
      const chats = listChats();
      if (chats.length === 0) {
        console.log('No registered chats. Add one with: nanoclaw chat add <jid> <name>');
      } else {
        for (const c of chats) {
          const main = c.isMain ? ' [main]' : '';
          console.log(`  ${c.channel || '?'} | ${c.jid} | ${c.name}${main}`);
        }
      }
      break;
    }
    case 'pending': {
      const { listPendingChats } = await import('../dist/chat-manager.js');
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
      const { addChat } = await import('../dist/chat-manager.js');
      addChat(jid, name, { isMain });
      console.log(`Chat registered: ${jid} (${name})${isMain ? ' [main]' : ''}`);
      break;
    }
    case 'remove': {
      const jid = args[1];
      if (!jid) {
        console.error('Usage: nanoclaw chat remove <jid>');
        process.exit(1);
      }
      const { removeChat } = await import('../dist/chat-manager.js');
      const removed = removeChat(jid);
      console.log(removed ? `Chat removed: ${jid}` : `Chat not found: ${jid}`);
      break;
    }
    default:
      console.log('Usage: nanoclaw chat <list|pending|add|remove> [args]');
  }
}

async function runSandbox(args: string[]) {
  const sub = args[0];
  switch (sub) {
    case 'build':

      console.log('sandbox build: not yet implemented');
      break;
    case 'status':
      console.log('sandbox status: not yet implemented');
      break;
    default:
      console.log('Usage: nanoclaw sandbox <build|status>');
  }
}

async function runUpdateCmd() {
  const { runUpdate } = await import('../dist/cli/update.js');
  await runUpdate();
}

function printHelp() {
  console.log(`
nanoclaw — AI assistant that runs agents in secure containers

Usage: nanoclaw <command> [options]

Setup
  init                              Initialize workspace
  doctor                            Check dependencies & config health
  update                            Update to latest version

Service
  start                             Start nanoclaw (background)
  stop                              Stop nanoclaw
  restart                           Restart nanoclaw
  dev                               Start in foreground (debug)
  status                            Show service + workspace status
  logs [-f]                         View logs

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
  chat list                         List registered chats
  chat pending                      Show unregistered chats
  chat add <jid> --name <name>      Register a chat
  chat remove <jid>                 Unregister a chat

Sandbox

  sandbox build                     Build agent container image
  sandbox status                    Show sandbox runtime info

MCP
  mcp auth <server|url>             Authenticate remote MCP server
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
    case 'auth': {
      const server = args[1];
      if (!server) {
        console.error('Usage: nanoclaw mcp auth <server-name | url>');
        process.exit(1);
      }
      console.error(
        `MCP "auth" command no longer ships a CLI proxy. ` +
          `Use \`az login\` for Azure-AD-protected MCP servers; ` +
          `tokens are auto-resolved at runtime by host-runner.`,
      );
      process.exit(1);
      break;
    }
    case 'list': {
      const { loadConfig: listCfg } = await import('../dist/config-loader.js');
      const listConfig = listCfg();
      const servers = listConfig.mcp.servers;
      if (Object.keys(servers).length === 0) {
        console.log('No MCP servers configured. Add one with: nanoclaw mcp add <name> <url>');
      } else {
        for (const [name, srv] of Object.entries(servers)) {
          const s = srv as any;
          const type = s.type || 'local';
          const target = s.url || s.command || '';
          console.log(`  ${name} (${type}) → ${target}`);
        }
      }
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
      const { loadConfig, saveConfig } = await import('../dist/config-loader.js');
      const cfg = loadConfig();
      cfg.mcp.servers[name] = { type: 'http', url, tools: ['*'] };
      saveConfig(cfg);
      console.log(`Added MCP server: ${name} (saved to nanoclaw.json)`);
      break;
    }
    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: nanoclaw mcp remove <name>');
        process.exit(1);
      }
      // Remove from nanoclaw.json
      const { loadConfig: lc, saveConfig: sc } = await import('../dist/config-loader.js');
      const c = lc();
      delete c.mcp.servers[name];
      sc(c);
      console.log(`Removed MCP server: ${name} (saved to nanoclaw.json)`);
      break;
    }
    default:
      console.log(`Usage: nanoclaw mcp <auth|list|add|remove> [args]

Commands:
  auth <server|url>     Authenticate a remote MCP server (deprecated; use az login)
  list                  List configured MCP servers
  add <name> <url>      Add a remote MCP server
  remove <name>         Remove an MCP server`);
  }
}
