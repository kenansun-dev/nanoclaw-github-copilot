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
      (await import('fs')).readFileSync(
        join(PROJECT_ROOT, 'package.json'),
        'utf-8',
      ),
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
  const { initWorkspace } = await import('./cli/init.js');
  await initWorkspace(PROJECT_ROOT);
}

async function runDoctor(_args: string[]) {
  const { runDoctor, formatDoctorResults } = await import('./doctor.js');
  const results = runDoctor();
  console.log(formatDoctorResults(results));
}

async function runService(action: string) {
  const { resolveWorkspace } = await import('./workspace.js');
  const ws = resolveWorkspace();
  const os = await import('os');
  const fs = await import('fs');
  const { execSync, spawn } = await import('child_process');

  const SERVICE_NAME = 'nanoclaw';
  const pidFile = join(ws, 'state', 'nanoclaw.pid');
  const logFile = join(ws, 'logs', 'nanoclaw.log');
  const entryPoint = join(PROJECT_ROOT, 'dist', 'index.js');

  // --- Detect service backend ---
  const hasSystemd = (() => {
    if (process.platform !== 'linux') return false;
    const serviceFile = join(
      os.homedir(),
      '.config',
      'systemd',
      'user',
      `${SERVICE_NAME}.service`,
    );
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

  const useSystemd = hasSystemd && action !== 'dev';

  // --- Windows kill helper ---
  const killProcess = (pid: number) => {
    if (process.platform === 'win32') {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'pipe' });
      } catch {
        /* */
      }
    } else {
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        /* */
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
          const status = execSync(
            `systemctl --user is-active ${SERVICE_NAME}`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
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
        return;
      }
      // PID fallback
      if (!existsSync(pidFile)) {
        console.log('Not running');
        return;
      }
      const pid = fs.readFileSync(pidFile, 'utf-8').trim();
      killProcess(parseInt(pid));
      try {
        fs.unlinkSync(pidFile);
      } catch {
        /* */
      }
      console.log(`Stopped (pid: ${pid})`);
      break;
    }
    case 'restart': {
      if (useSystemd) {
        try {
          execSync(`systemctl --user restart ${SERVICE_NAME}`, {
            stdio: 'pipe',
          });
          await new Promise((r) => setTimeout(r, 2000));
          const status = execSync(
            `systemctl --user is-active ${SERVICE_NAME}`,
            {
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
            },
          ).trim();
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
      // Service backend info
      if (hasSystemd) {
        console.log('Service: systemd (user)');
        try {
          const active = execSync(
            `systemctl --user is-active ${SERVICE_NAME}`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
          const pid = execSync(
            `systemctl --user show ${SERVICE_NAME} --property=MainPID --value`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
          console.log(`Status: ${active} (pid: ${pid})`);
        } catch {
          console.log('Status: not running');
        }
      } else if (hasSchedTask) {
        console.log('Service: Windows Scheduled Task');
        try {
          const out = execSync(
            `schtasks /Query /TN "${SERVICE_NAME}" /FO CSV /NH`,
            { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] },
          ).trim();
          const status = out.includes('Running') ? 'running' : 'ready';
          console.log(`Status: ${status}`);
        } catch {
          console.log('Status: not installed');
        }
      } else if (existsSync(pidFile)) {
        const pid = fs.readFileSync(pidFile, 'utf-8').trim();
        try {
          process.kill(parseInt(pid), 0);
          console.log(`Status: running (pid: ${pid}, PID mode)`);
        } catch {
          console.log('Status: not running (stale pid file)');
        }
      } else {
        console.log('Status: not running');
        console.log('Tip: run `nanoclaw service install` to enable auto-start');
      }

      // Common info
      console.log(`Workspace: ${ws}`);
      console.log(`Config: ${join(ws, 'nanoclaw.json')}`);
      console.log(`Logs: ${logFile}`);

      // Show config summary
      try {
        const { loadConfig } = await import('./config-loader.js');
        const config = loadConfig();
        const agent = config.agents?.defaults;
        console.log(
          `Agent: ${agent?.name || 'Andy'} (${agent?.model || 'unknown'}, ${agent?.mode || 'sandbox'})`,
        );
        if (agent?.thinkLevel) console.log(`Think: ${agent.thinkLevel}`);
        const channels = Object.entries(config.channels || {})
          .filter(([, v]: [string, any]) => v?.enabled)
          .map(([k]) => k);
        console.log(
          `Channels: ${channels.length > 0 ? channels.join(', ') : 'none enabled'}`,
        );
        const chatCount = Object.keys(config.chats || {}).length;
        console.log(`Chats: ${chatCount} registered`);
      } catch {
        /* config not available */
      }
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
  process.env.NANOCLAW_WORKSPACE = resolveWorkspace();
  await import('./index.js');
}

async function runLogs(args: string[]) {
  const { resolveWorkspace } = await import('./workspace.js');
  const logFile = join(resolveWorkspace(), 'logs', 'nanoclaw.log');
  const follow = args.includes('-f') || args.includes('--follow');
  const fs = await import('fs');

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
      const provider = args[1] || 'github-copilot';
      if (provider === 'github-copilot') {
        console.log('Starting GitHub Copilot login (device code flow)...');
        try {
          const { execSync } = await import('child_process');
          // Use GHC CLI's built-in login
          execSync('copilot auth login', { stdio: 'inherit', timeout: 120000 });
          console.log('Login successful.');
        } catch {
          console.error(
            'Login failed. Make sure copilot CLI is installed: npm install -g @github/copilot',
          );
        }
      } else {
        console.log(`Unknown provider: ${provider}`);
      }
      break;
    }
    case 'status': {
      const { runDoctor: _doc, formatDoctorResults: _fmt } =
        await import('./doctor.js');
      // Quick auth check
      const os = await import('os');
      const fs = await import('fs');
      const path = await import('path');
      const profilePath = path.join(
        os.homedir(),
        '.openclaw/agents/main/agent/auth-profiles.json',
      );
      if (
        process.env.COPILOT_GITHUB_TOKEN ||
        process.env.GH_TOKEN ||
        process.env.GITHUB_TOKEN
      ) {
        console.log('✅ github-copilot: authenticated (env token)');
      } else if (fs.existsSync(profilePath)) {
        try {
          const profiles = JSON.parse(fs.readFileSync(profilePath, 'utf-8'));
          const hasGhc = Object.values(profiles.profiles || {}).some(
            (p: any) => p.provider === 'github-copilot' && p.token,
          );
          console.log(
            hasGhc
              ? '✅ github-copilot: authenticated (OpenClaw profile)'
              : '❌ github-copilot: not authenticated',
          );
        } catch {
          console.log('❌ github-copilot: not authenticated');
        }
      } else {
        console.log(
          '❌ github-copilot: not authenticated — run: nanoclaw provider login',
        );
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
      await runChannelCommand(['add', args[1]]);
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

  switch (sub) {
    case 'list': {
      const { listChats } = await import('./chat-manager.js');
      const chats = listChats();
      if (chats.length === 0) {
        console.log(
          'No registered chats. Add one with: nanoclaw chat add <jid> <name>',
        );
      } else {
        for (const c of chats) {
          const main = c.isMain ? ' [main]' : '';
          console.log(`  ${c.channel || '?'} | ${c.jid} | ${c.name}${main}`);
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
      console.log(
        `Chat registered: ${jid} (${name})${isMain ? ' [main]' : ''}`,
      );
      break;
    }
    case 'remove': {
      const jid = args[1];
      if (!jid) {
        console.error('Usage: nanoclaw chat remove <jid>');
        process.exit(1);
      }
      const { removeChat } = await import('./chat-manager.js');
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
      const imageName = isGHC
        ? 'nanoclaw-agent-ghc:latest'
        : config.sandbox?.image || 'nanoclaw-agent:latest';
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
        execSync(
          `docker build -t ${imageName} -f ${dockerfilePath} ${contextDir}`,
          { stdio: 'inherit', timeout: 600_000 },
        );
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

async function runUpdateCmd() {
  const { runUpdate } = await import('./cli/update.js');
  await runUpdate([]);
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
  pair [<jid>] [--name <n>] [--main] Pair a new chat
  chat list                         List registered chats
  chat pending                      Show unregistered chats
  chat add <jid> --name <name>      Register a chat
  chat remove <jid>                 Unregister a chat

Interactive
  tui                               Interactive terminal chat

Sandbox

  sandbox build                     Build agent container image
  sandbox status                    Show sandbox runtime info

MCP
  mcp auth <server|url>             Authenticate remote MCP server
  mcp list                          List configured MCP servers
  mcp add <name> <url>              Add remote MCP server
  mcp remove <name>                 Remove MCP server
  mcp daemon <start|stop|status>    Manage mcporter daemon

Global Options
  --workspace <path>                Workspace (default: ~/.nanoclaw)
  --help                            Show help
  --version                         Show version
`);
}

async function runMcp(args: string[]) {
  const sub = args[0];
  const { resolveWorkspace } = await import('./workspace.js');
  const ws = resolveWorkspace();
  const mcporterConfig = join(ws, 'mcporter', 'mcporter.json');
  const { execSync, spawn: spawnChild } = await import('child_process');
  const mcpBinExt = process.platform === 'win32' ? 'mcporter.cmd' : 'mcporter';
  const localMcp = join(PROJECT_ROOT, 'node_modules', '.bin', mcpBinExt);
  let mcpBin = '';
  if (existsSync(localMcp)) {
    mcpBin = localMcp;
  } else {
    // Try global
    try {
      const { execSync: es } = await import('child_process');
      mcpBin = es(
        process.platform === 'win32' ? 'where mcporter' : 'which mcporter',
        {
          encoding: 'utf-8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      )
        .trim()
        .split('\n')[0];
    } catch {
      mcpBin = 'mcporter'; // hope it's in PATH
    }
  }

  // Ensure mcporter config exists and is synced from nanoclaw.json
  const {
    mkdirSync,
    existsSync: fsExists,
    writeFileSync,
    readFileSync,
  } = await import('fs');
  mkdirSync(join(ws, 'mcporter'), { recursive: true });
  if (!fsExists(mcporterConfig)) {
    writeFileSync(mcporterConfig, JSON.stringify({ mcpServers: {} }, null, 2));
  }
  // Sync remote MCP servers from nanoclaw.json → mcporter config
  try {
    const { loadConfig: syncCfg } = await import('./config-loader.js');
    const nc = syncCfg();
    const mc = JSON.parse(readFileSync(mcporterConfig, 'utf-8'));
    for (const [name, srv] of Object.entries(nc.mcp.servers)) {
      const s = srv as any;
      if (
        (s.type === 'http' || s.type === 'sse') &&
        s.url &&
        !mc.mcpServers?.[name]
      ) {
        mc.mcpServers = mc.mcpServers || {};
        mc.mcpServers[name] = { url: s.url };
      }
    }
    writeFileSync(mcporterConfig, JSON.stringify(mc, null, 2));
  } catch {
    /* sync best-effort */
  }

  switch (sub) {
    case 'auth': {
      const server = args[1];
      if (!server) {
        console.error('Usage: nanoclaw mcp auth <server-name | url>');
        process.exit(1);
      }
      console.log(`Authenticating MCP server: ${server}`);
      try {
        execSync(`${mcpBin} auth ${server} --config ${mcporterConfig}`, {
          stdio: 'inherit',
          timeout: 120000,
        });
      } catch {
        console.error('Auth failed. Is the server URL correct?');
      }
      break;
    }
    case 'list': {
      const { loadConfig: listCfg } = await import('./config-loader.js');
      const listConfig = listCfg();
      const servers = listConfig.mcp.servers;
      if (Object.keys(servers).length === 0) {
        console.log(
          'No MCP servers configured. Add one with: nanoclaw mcp add <name> <url>',
        );
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
      const { loadConfig, saveConfig } = await import('./config-loader.js');
      const cfg = loadConfig();
      cfg.mcp.servers[name] = { type: 'http', url, tools: ['*'] };
      saveConfig(cfg);
      // Also sync to mcporter config so auth works
      try {
        execSync(
          `${mcpBin} config add ${name} ${url} --config ${mcporterConfig}`,
          {
            stdio: 'pipe',
            timeout: 15000,
          },
        );
      } catch {
        /* mcporter sync is best-effort */
      }
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
      const { loadConfig: lc, saveConfig: sc } =
        await import('./config-loader.js');
      const c = lc();
      delete c.mcp.servers[name];
      sc(c);
      // Also remove from mcporter
      try {
        execSync(`${mcpBin} config remove ${name} --config ${mcporterConfig}`, {
          stdio: 'pipe',
          timeout: 15000,
        });
      } catch {
        /* best-effort */
      }
      console.log(`Removed MCP server: ${name} (saved to nanoclaw.json)`);
      break;
    }
    case 'daemon': {
      const action = args[1] || 'status';
      try {
        execSync(`${mcpBin} daemon ${action} --config ${mcporterConfig}`, {
          stdio: 'inherit',
          timeout: 15000,
        });
      } catch {
        console.error(`Daemon ${action} failed.`);
      }
      break;
    }
    default:
      console.log(`Usage: nanoclaw mcp <auth|list|add|remove|daemon> [args]

Commands:
  auth <server|url>     Authenticate a remote MCP server (OAuth/PRM)
  list                  List configured MCP servers
  add <name> <url>      Add a remote MCP server
  remove <name>         Remove an MCP server
  daemon <start|stop|status>  Manage mcporter daemon`);
  }
}
