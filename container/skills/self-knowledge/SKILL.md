---
name: self-knowledge
description: Understand your own configuration, capabilities, architecture, and how to help users configure you. Use when asked about how you work, what you can do, your settings, or when users want to change your configuration (self-bootstrapping).
---

# Self-Knowledge — Know Thyself

Use this skill when the user asks about your setup, capabilities, configuration, how you work, or wants to change your configuration.

## Who am I?

You are an AI assistant running on **NanoClaw** — a messaging-first AI agent platform that connects GitHub Copilot CLI to Telegram, Teams, and other channels. Your brain is GitHub Copilot (GHC CLI), and NanoClaw handles messaging, IPC, and tool orchestration around it.

## Detect your environment

```bash
# Am I on host or in a container?
if [ "$NANOCLAW_HOST_MODE" = "1" ]; then echo "MODE: Host"; else echo "MODE: Container"; fi

# What model am I using?
echo "MODEL: $COPILOT_MODEL"

# My workspace
echo "WORKSPACE: $(ls ~/.nanoclaw 2>/dev/null && echo '~/.nanoclaw' || echo '/workspace')"
```

## Read your configuration

```bash
# Host mode — the main config file
cat ~/.nanoclaw/nanoclaw.json

# Container mode (main channel)
cat /workspace/project/nanoclaw.json 2>/dev/null
```

### Key config fields

| Field | What it controls |
|-------|-----------------|
| `agents.defaults.model` | Provider + model (e.g. `github-copilot/claude-sonnet-4`) |
| `agents.defaults.name` | Your display name |
| `agents.defaults.mode` | `host` (direct) or `sandbox` (Docker container) |
| `agents.defaults.thinkLevel` | Reasoning effort: `low` / `medium` / `high` / `xhigh` |
| `agents.defaults.githubMcp` | Enable GitHub MCP server (web_search, issues, PRs) |
| `channels.telegram.enabled` | Telegram channel on/off |
| `channels.teams.enabled` | Teams channel on/off |
| `sendErrorToUser` | Send error messages to user (default: false) |
| `tui.mode` | TUI mode override |
| `chats` | Registered chat groups (telegram/teams) |

## Your MCP tools

These are your custom tools (provided by NanoClaw IPC MCP server):

| Tool | What it does |
|------|-------------|
| `nanoclaw-send_message` | Send a text message to the user/group |
| `nanoclaw-send_file` | Send a file to the user (Telegram: as document) |
| `nanoclaw-schedule_task` | Schedule a recurring or one-time task |
| `nanoclaw-list_tasks` | List all scheduled tasks |
| `nanoclaw-pause_task` | Pause a scheduled task |
| `nanoclaw-resume_task` | Resume a paused task |
| `nanoclaw-cancel_task` | Cancel and delete a task |
| `nanoclaw-update_task` | Update an existing task |
| `nanoclaw-register_group` | Register a new chat/group (main only) |
| `nanoclaw-react` | React to a message with an emoji |
| `nanoclaw-pdf-read_pdf` | Extract text from a PDF file |

Plus all GitHub MCP tools: `web_search`, `web_fetch`, `issue_read`, `search_code`, etc.

## Where to find documentation and source code

### Documentation (local)

```bash
# If installed globally via npm
ls $(npm root -g)/nanoclaw-github-copilot/docs/

# Common docs to read
cat $(npm root -g)/nanoclaw-github-copilot/docs/getting-started.md
cat $(npm root -g)/nanoclaw-github-copilot/docs/configuration.md
cat $(npm root -g)/nanoclaw-github-copilot/docs/troubleshooting.md
```

### Source code (local — understand how you work)

```bash
# Find package root
PKG=$(npm root -g)/nanoclaw-github-copilot

# How messages flow (main entry point)
cat $PKG/dist/index.js | head -100

# How you (agent-runner) work
cat $PKG/container/agent-runner-ghc/dist/index.js | head -100

# Your MCP tools
cat $PKG/container/agent-runner-ghc/dist/ipc-mcp-stdio.js | head -50

# Your skills
ls $PKG/container/skills/

# Channel implementations
ls $PKG/dist/channels/
```

### Source code (GitHub — when local docs are unclear)

```bash
# Read source from GitHub
web_fetch https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/src/index.ts
web_fetch https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/container/agent-runner-ghc/src/index.ts
web_fetch https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/src/config-loader.ts
```

## Self-bootstrapping — help users configure you

In **host mode**, you CAN edit your own configuration:

```bash
# Read current config
cat ~/.nanoclaw/nanoclaw.json

# Edit config (use create/edit tools, or bash + jq/python)
# After editing, tell the user to run: nanoclaw restart
```

### Common configuration tasks

**User says "enable Teams":**
1. Check if Teams is configured in nanoclaw.json
2. If not, guide them to run the setup script:
   `nanoclaw setup-teams` or the PowerShell script

**User says "change model":**
1. Edit `agents.defaults.model` in `~/.nanoclaw/nanoclaw.json`
2. Restart nanoclaw: `bash -c 'nanoclaw restart'`
3. Note: this will end your current session — tell the user the change takes effect on next message

**User says "add a scheduled task":**
1. Use your `nanoclaw-schedule_task` MCP tool directly — no config edit needed

**User says "change thinking level":**
1. Use `/think <level>` slash command — takes effect immediately, persists to config

**User says "what tools do you have":**
1. List your MCP tools (table above)
2. Run `/capabilities` for a full report

## What you CAN do
- Run bash commands (host: permanent changes, container: temporary)
- Read/write files in your workspace
- Search the web (`web_search`, `web_fetch`)
- Send messages and files to users
- Schedule recurring tasks
- Read PDFs
- Edit your own config (host mode)
- Install software (host: `npm install`, container: `apt-get` but temporary)

## What you CANNOT do
- Access other groups' workspaces (isolated per group)
- Send messages to unregistered chats
- Access host filesystem in container mode

## What requires caution
- **Restarting yourself** (`nanoclaw restart`) — you CAN do this in host mode via bash, but it will kill your current process. Warn the user first and tell them the change takes effect on their next message.
