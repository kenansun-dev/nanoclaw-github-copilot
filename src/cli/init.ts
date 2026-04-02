/**
 * nanoclaw init — create workspace from templates
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveWorkspace, ensureWorkspace } from '../workspace.js';

export async function initWorkspace(projectRoot: string): Promise<void> {
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
  if (!isUpdate)
    fs.writeFileSync(path.join(ws, 'nanoclaw.json'), configTemplate);

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
  const agentRunnerDir = path.join(
    projectRoot,
    'container',
    'agent-runner-ghc',
  );
  // Check agent-runner source exists
  const runnerSrc = path.join(agentRunnerDir, 'src', 'index.ts');
  if (fs.existsSync(agentRunnerDir)) {
    if (!fs.existsSync(runnerSrc)) {
      console.warn(
        '  Warning: agent-runner-ghc source not found. Package may be incomplete.',
      );
    }
    // Check if critical dependency exists (fs check, not npm ls)
    const sdkDir = path.join(
      agentRunnerDir,
      'node_modules',
      '@github',
      'copilot-sdk',
    );
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
  const readline = await import('readline');
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const ask = (q: string): Promise<string> =>
    new Promise((resolve) => rl.question(q, resolve));

  console.log('\n--- Quick Setup ---\n');

  // Auth
  const hasToken = process.env.COPILOT_GITHUB_TOKEN || process.env.GH_TOKEN;
  if (!hasToken) {
    console.log('GitHub Copilot auth not found.');
    console.log('  Option 1: Set COPILOT_GITHUB_TOKEN in .env');
    console.log('  Option 2: Run: copilot login');
    console.log(
      '  Option 3: If OpenClaw is installed, auth is shared automatically',
    );
    console.log('');
  }

  // Channel
  const enableTg = await ask('Enable Telegram? (y/N): ');
  if (enableTg.toLowerCase() === 'y') {
    const token = await ask('Telegram bot token: ');
    if (token) {
      const envPath = path.join(ws, '.env');
      const fs2 = await import('fs');
      let env = fs2.readFileSync(envPath, 'utf-8');
      env = env.replace('# TELEGRAM_BOT_TOKEN=', `TELEGRAM_BOT_TOKEN=${token}`);
      fs2.writeFileSync(envPath, env);
      // Enable in config
      const config = JSON.parse(
        fs2.readFileSync(path.join(ws, 'nanoclaw.json'), 'utf-8'),
      );
      config.channels = config.channels || {};
      config.channels.telegram = { enabled: true };
      fs2.writeFileSync(
        path.join(ws, 'nanoclaw.json'),
        JSON.stringify(config, null, 2) + '\n',
      );
      console.log('✅ Telegram configured');
    }
  }

  const enableTeams = await ask('Enable Teams? (y/N): ');
  if (enableTeams.toLowerCase() === 'y') {
    console.log(
      '  Run: scripts/setup-teams.sh (Linux) or scripts/setup-teams.ps1 (Windows)',
    );
  }

  rl.close();

  console.log(`
✅ Workspace created at ${ws}

Files:
  ${ws}/nanoclaw.json    — Main config (edit this)
  ${ws}/.env             — Credentials (fill in tokens)
  ${ws}/AGENT.md         — Agent personality (customize)
  ${ws}/skills/          — Custom skills
  ${ws}/docs/            — Documentation

Next steps:
  1. Edit nanoclaw.json — set assistant name, enable channels
  2. Edit .env — add bot tokens / credentials
  3. Run: nanoclaw doctor — check everything is ready
  4. Run: nanoclaw sandbox build — build agent container (sandbox mode)
     Or set "mode": "host" in nanoclaw.json to skip Docker
  5. Run: nanoclaw start — start the service
`);

  // Write version file for tracking
  try {
    const pkgJsonPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
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
    idleTimeout: 0,
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
