/**
 * nanoclaw init — create workspace from templates
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveWorkspace, ensureWorkspace } from '../workspace.js';

export async function initWorkspace(projectRoot: string, args: string[] = []): Promise<void> {
  // --sync / --no-prompt: skip the interactive setup wizard entirely.
  // Used by `nanoclaw update` so a re-install doesn't re-prompt the user
  // for Telegram/Teams/auth choices that were already made on first install.
  const syncOnly = args.includes('--sync') || args.includes('--no-prompt') || args.includes('--non-interactive');

  const ws = resolveWorkspace();

  const isUpdate = fs.existsSync(path.join(ws, 'nanoclaw.json'));
  if (isUpdate) {
    console.log(`Workspace exists at ${ws} — updating missing files...`);
  } else {
    console.log(`Initializing workspace at ${ws}...`);
  }

  // Create directory structure
  ensureWorkspace();

  // Copy templates
  const templatesDir = path.join(projectRoot, 'templates');

  // nanoclaw.json
  const configTemplate = fs.existsSync(path.join(templatesDir, 'nanoclaw.json'))
    ? fs.readFileSync(path.join(templatesDir, 'nanoclaw.json'), 'utf-8')
    : JSON.stringify(DEFAULT_CONFIG, null, 2);
  if (!isUpdate) fs.writeFileSync(path.join(ws, 'nanoclaw.json'), configTemplate);

  // .env
  const envTemplate = fs.existsSync(path.join(templatesDir, '.env.template'))
    ? fs.readFileSync(path.join(templatesDir, '.env.template'), 'utf-8')
    : DEFAULT_ENV;
  if (!fs.existsSync(path.join(ws, '.env'))) {
    fs.writeFileSync(path.join(ws, '.env'), envTemplate, { mode: 0o600 });
    console.log('  Created .env');
  } else {
    console.log('  .env already exists — skipping');
  }

  // AGENT.md
  const agentMd = fs.existsSync(path.join(templatesDir, 'AGENT.md'))
    ? fs.readFileSync(path.join(templatesDir, 'AGENT.md'), 'utf-8')
    : DEFAULT_AGENT_MD;
  if (!fs.existsSync(path.join(ws, 'AGENT.md'))) {
    fs.writeFileSync(path.join(ws, 'AGENT.md'), agentMd);
    console.log('  Created AGENT.md');
  } else {
    console.log('  AGENT.md already exists — skipping');
  }

  // Copy docs
  const srcDocs = path.join(projectRoot, 'docs');
  const dstDocs = path.join(ws, 'docs');
  if (fs.existsSync(srcDocs)) {
    copyDirSync(srcDocs, dstDocs, isUpdate);
  }

  // Copy default skills to workspace
  const skillsDst = path.join(ws, 'skills');
  fs.mkdirSync(skillsDst, { recursive: true });
  const containerSkills = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(containerSkills)) {
    copyDirSync(containerSkills, skillsDst, isUpdate);
    console.log(`  Synced skills to ${skillsDst}`);
  }

  // Host mode: install agent-runner dependencies
  const agentRunnerDir = path.join(projectRoot, 'container', 'agent-runner-ghc');
  // Check agent-runner source exists
  const runnerSrc = path.join(agentRunnerDir, 'src', 'index.ts');
  if (fs.existsSync(agentRunnerDir)) {
    if (!fs.existsSync(runnerSrc)) {
      console.warn('  Warning: agent-runner-ghc source not found. Package may be incomplete.');
    }
    // Check if critical dependency exists (fs check, not npm ls)
    const sdkDir = path.join(agentRunnerDir, 'node_modules', '@github', 'copilot-sdk');
    if (!fs.existsSync(sdkDir)) {
      console.log('Installing agent-runner dependencies (host mode)...');
      try {
        const { execSync } = await import('child_process');
        execSync('npm install', {
          cwd: agentRunnerDir,
          stdio: 'inherit',
          timeout: 120000,
        });
        console.log('  Agent-runner dependencies installed');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`  Warning: Failed to install agent-runner deps: ${msg}`);
        console.warn(`  Run manually: cd ${agentRunnerDir} && npm install`);
      }
    } else {
      console.log('  Agent-runner dependencies already installed');
    }
  } else {
    console.log(`  Agent-runner directory not found at ${agentRunnerDir}`);
  }

  // Interactive onboard: auth + channel setup
  // Skip interactive prompts in non-TTY mode (pipes, scripts, CI)
  if (!process.stdin.isTTY) {
    console.log('');
    console.log('Non-interactive mode detected. Skipping channel setup.');
    console.log('Edit nanoclaw.json to configure channels manually.');
    return;
  }

  // Explicit sync mode: caller (e.g. `nanoclaw update`) already has a
  // configured workspace and doesn't want the wizard to re-ask Telegram /
  // Teams / auth choices.
  if (syncOnly) {
    console.log('');
    console.log('Sync mode — skipping interactive setup wizard.');
    return;
  }

  // Defensive: if workspace already has channels configured, the wizard
  // would just re-ask things the user already answered. Skip silently on
  // re-runs (`isUpdate`) when at least one channel is already enabled.
  if (isUpdate) {
    try {
      const cfgRaw = fs.readFileSync(path.join(ws, 'nanoclaw.json'), 'utf-8');
      const cfg = JSON.parse(cfgRaw);
      const channels = cfg?.channels || {};
      const hasConfiguredChannel = Object.values(channels).some(
        (c: any) => c && typeof c === 'object' && c.enabled === true,
      );
      if (hasConfiguredChannel) {
        console.log('');
        console.log('Workspace already configured — skipping channel setup wizard.');
        console.log('Re-run with `nanoclaw init --force` to reconfigure.');
        return;
      }
    } catch {
      // Config unreadable — fall through to wizard so user can recover.
    }
  }

  // Allow explicit opt-in to re-run the wizard even when channels exist.
  if (args.includes('--force')) {
    // no-op; just continue to the wizard below
  }
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  console.log('\n--- Quick Setup ---\n');

  // Mode selection
  const hasDocker = await checkDocker();
  if (hasDocker) {
    const modeChoice = await ask('Run mode — sandbox (Docker) or host (direct)? (S/h): ');
    if (modeChoice.toLowerCase() === 'h') {
      updateConfigField(ws, 'agents.defaults.mode', 'host');
      console.log('✅ Mode: host');
    } else {
      updateConfigField(ws, 'agents.defaults.mode', 'sandbox');
      console.log('✅ Mode: sandbox (Docker)');
    }
  } else {
    console.log('Docker not available — using host mode.');
    updateConfigField(ws, 'agents.defaults.mode', 'host');
    console.log('✅ Mode: host');
  }
  console.log('');

  // Auth
  const hasToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!hasToken) {
    // Check if copilot CLI is logged in or has stored auth
    let copilotLoggedIn = false;
    try {
      const { execSync } = await import('child_process');
      execSync('copilot --version', { stdio: 'pipe', timeout: 5000 });
      copilotLoggedIn = true;
    } catch {
      /* not available */
    }

    // Check ~/.copilot/ directory (GHC CLI's own auth storage)
    const homeCopilotDir = path.join(process.env.HOME || process.env.USERPROFILE || '', '.copilot');
    const hasCopilotAuth = fs.existsSync(path.join(homeCopilotDir, 'config.json'));

    if (copilotLoggedIn || hasCopilotAuth) {
      console.log('✅ GitHub Copilot auth found' + (hasCopilotAuth ? ' (~/.copilot/)' : ' (CLI)'));
    } else {
      console.log('GitHub Copilot auth not found.');
      const loginChoice = await ask('Run copilot login now? (Y/n): ');
      if (loginChoice.toLowerCase() !== 'n') {
        try {
          const { execSync } = await import('child_process');
          execSync('nanoclaw auth login', {
            stdio: 'inherit',
            timeout: 120000,
          });
          console.log('\u2705 Auth configured');
        } catch {
          console.log('  Auth failed. Run manually: nanoclaw auth login');
        }
      } else {
        console.log('  Skipped. Run later: nanoclaw auth login');
      }
    }
    console.log('');
  } else {
    console.log('✅ GitHub auth found');
    console.log('');
  }

  // Channel
  const enableTg = await ask('Enable Telegram? (y/N): ');
  if (enableTg.toLowerCase() === 'y') {
    const token = await ask('Telegram bot token: ');
    if (token) {
      // Write credentials to nanoclaw.json (single source of truth)
      const configPath = path.join(ws, 'nanoclaw.json');
      const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      config.channels = config.channels || {};
      config.channels.telegram = {
        ...config.channels.telegram,
        enabled: true,
        botToken: token.trim(),
      };
      fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
      console.log('✅ Telegram configured');
    }
  }

  const enableTeams = await ask('Enable Teams? (y/N): ');
  if (enableTeams.toLowerCase() === 'y') {
    try {
      const { runChannelCommand } = await import('./channel.js');
      await runChannelCommand(['add', 'teams']);
    } catch (err: any) {
      console.log(`  Teams setup failed: ${err.message}`);
      console.log('  Run later: nanoclaw channel add teams');
    }
  }

  rl.close();

  console.log('');
  console.log(`\u2705 Setup complete! Workspace: ${ws}`);
  console.log('');
  console.log('  Config:      ' + path.join(ws, 'nanoclaw.json'));
  console.log('  Credentials: ' + path.join(ws, '.env'));
  console.log('  Agent:       ' + path.join(ws, 'AGENT.md'));
  console.log('');

  // Offer to start
  if (process.stdin.isTTY) {
    const rl2 = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const ask2 = (q: string): Promise<string> => new Promise((resolve) => rl2.question(q, resolve));
    const startNow = await ask2('Start nanoclaw now? (Y/n): ');
    rl2.close();
    if (startNow.toLowerCase() !== 'n') {
      console.log('');
      try {
        const { execSync } = await import('child_process');
        const finalConfig = JSON.parse(fs.readFileSync(path.join(ws, 'nanoclaw.json'), 'utf-8'));
        if (finalConfig.agents?.defaults?.mode === 'sandbox') {
          console.log('Building container...');
          try {
            execSync('nanoclaw sandbox build', {
              stdio: 'inherit',
              timeout: 300000,
            });
          } catch {
            console.log('Container build failed \u2014 switching to host mode.');
            updateConfigField(ws, 'agents.defaults.mode', 'host');
          }
        }
        execSync('nanoclaw start', { stdio: 'inherit', timeout: 30000 });
      } catch (err: any) {
        console.log(`Start failed: ${err.message}`);
        console.log('Run manually: nanoclaw start');
      }
    } else {
      console.log('');
      console.log('To start: nanoclaw start');
      console.log('To check: nanoclaw doctor');
    }
  } else {
    console.log('To start: nanoclaw start');
  }

  // Write version file for tracking
  try {
    const pkgJsonPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    if (fs.existsSync(pkgJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      const versionInfo = JSON.stringify(
        {
          version: pkg.version || 'unknown',
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      );
      fs.writeFileSync(path.join(ws, '.version.json'), versionInfo);
      console.log(`  Version: ${pkg.version}`);
    }
  } catch {
    /* best effort */
  }
}

function copyDirSync(src: string, dst: string, skipExisting = false) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath, skipExisting);
    } else {
      if (skipExisting && fs.existsSync(dstPath)) continue;
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

const DEFAULT_CONFIG = {
  agents: {
    defaults: {
      model: 'github-copilot/claude-sonnet-4',
      name: 'Andy',
      triggerWord: '@Andy',
      hasOwnNumber: false,
      mode: 'sandbox' as const,
    },
  },
  channels: {
    telegram: { enabled: false },
    teams: { enabled: false },
  },
  chats: {},
  mcp: { servers: {} },
  skills: {
    directories: ['./skills'],
    disabled: [],
  },
  sandbox: {
    runtime: 'docker',
    image: 'nanoclaw-agent:latest',
    timeout: 1800000,
    maxOutputSize: 10485760,
    maxConcurrent: 5,
    // v2 host-sweep tunables. absoluteCeilingMs=0 disables the
    // heartbeat-age throttle (owner directive 2026-05-10).
    absoluteCeilingMs: 0,
    claimStuckMs: 60_000,
    sweepIntervalMs: 60_000,
  },
  credentialProxy: { port: 3001 },
  logLevel: 'info',
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
};

const DEFAULT_ENV = `# NanoClaw Credentials
# Fill in the values for your enabled channels.
# This file should NOT be committed to git.

# === Telegram ===
# TELEGRAM_BOT_TOKEN=

# === Teams ===
# MSTEAMS_APP_ID=
# MSTEAMS_APP_PASSWORD=
# MSTEAMS_TENANT_ID=

# === GitHub Copilot (optional — falls back to OpenClaw auth profile) ===
# COPILOT_GITHUB_TOKEN=
`;
async function checkDocker(): Promise<boolean> {
  try {
    const { execSync } = await import('child_process');
    execSync('docker info', { stdio: 'pipe', timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}

function updateConfigField(ws: string, fieldPath: string, value: any): void {
  const configPath = path.join(ws, 'nanoclaw.json');
  if (!fs.existsSync(configPath)) return;
  const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  const parts = fieldPath.split('.');
  let obj = config;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!obj[parts[i]]) obj[parts[i]] = {};
    obj = obj[parts[i]];
  }
  obj[parts[parts.length - 1]] = value;
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n');
}

const DEFAULT_AGENT_MD = `# NanoClaw Agent

You are a helpful AI assistant running inside NanoClaw.
You can execute commands, read and write files, search the web, and use MCP tools.

## Guidelines
- Be concise and helpful
- Ask for clarification when needed
- Use tools when they can help answer questions
- Be careful with destructive operations (prefer creating over deleting)

## Capabilities
- File operations (read, write, edit, create)
- Shell commands (bash)
- Web search and URL fetching
- MCP tools (as configured)
- Scheduled tasks

Customize this file to change the agent's personality and behavior.
`;
