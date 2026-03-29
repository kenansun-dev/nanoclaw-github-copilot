/**
 * nanoclaw init — create workspace from templates
 */

import fs from 'fs';
import path from 'path';
import { resolveWorkspace, ensureWorkspace } from '../workspace.js';

export async function initWorkspace(projectRoot: string): Promise<void> {
  const ws = resolveWorkspace();

  if (fs.existsSync(path.join(ws, 'nanoclaw.json'))) {
    console.log(`Workspace already exists at ${ws}`);
    console.log('Use --force to reinitialize (not implemented yet)');
    return;
  }

  console.log(`Initializing workspace at ${ws}...`);

  // Create directory structure
  ensureWorkspace();

  // Copy templates
  const templatesDir = path.join(projectRoot, 'templates');

  // nanoclaw.json
  const configTemplate = fs.existsSync(path.join(templatesDir, 'nanoclaw.json'))
    ? fs.readFileSync(path.join(templatesDir, 'nanoclaw.json'), 'utf-8')
    : JSON.stringify(DEFAULT_CONFIG, null, 2);
  fs.writeFileSync(path.join(ws, 'nanoclaw.json'), configTemplate);

  // .env
  const envTemplate = fs.existsSync(path.join(templatesDir, '.env.template'))
    ? fs.readFileSync(path.join(templatesDir, '.env.template'), 'utf-8')
    : DEFAULT_ENV;
  fs.writeFileSync(path.join(ws, '.env'), envTemplate, { mode: 0o600 });

  // AGENT.md
  const agentMd = fs.existsSync(path.join(templatesDir, 'AGENT.md'))
    ? fs.readFileSync(path.join(templatesDir, 'AGENT.md'), 'utf-8')
    : DEFAULT_AGENT_MD;
  fs.writeFileSync(path.join(ws, 'AGENT.md'), agentMd);

  // Copy docs
  const srcDocs = path.join(projectRoot, 'docs');
  const dstDocs = path.join(ws, 'docs');
  if (fs.existsSync(srcDocs)) {
    copyDirSync(srcDocs, dstDocs);
  }

  // Copy default skills to workspace
  const skillsDst = path.join(ws, 'skills');
  fs.mkdirSync(skillsDst, { recursive: true });
  const containerSkills = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(containerSkills)) {
    copyDirSync(containerSkills, skillsDst);
    console.log(`  Copied default skills to ${skillsDst}`);
  }

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
  4. Run: nanoclaw sandbox build — build agent container
  5. Run: nanoclaw start — start the service
`);
}

function copyDirSync(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

const DEFAULT_CONFIG = {
  assistant: {
    name: 'Andy',
  },
  providers: {
    'github-copilot': {
      model: 'gpt-4o-mini',
      auth: 'sso',
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
    maxConcurrent: 5,
  },
  security: {
    autoApproveChats: false,
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
