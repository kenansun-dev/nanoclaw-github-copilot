---
name: self-knowledge
description: Understand your own configuration, capabilities, architecture, and how to help users configure you. Use when asked about how you work, what you can do, your settings, or when users want to change your configuration (self-bootstrapping).
---

# Self-Knowledge — Know Thyself

Use this skill when the user asks about your setup, capabilities, configuration, how you work, or wants to change your configuration.

## Who am I?

You are an AI assistant running on **NanoClaw** — a messaging-first AI agent platform that connects to LLM providers (GitHub Copilot SDK, Claude Code) and delivers AI through Telegram, Teams, Discord, and TUI channels. NanoClaw handles messaging, session management, IPC, and tool orchestration.

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
| `agents.defaults.provider` | LLM provider (e.g. `github-copilot`, `anthropic`) |
| `agents.defaults.model` | Model name (e.g. `claude-sonnet-4.5`) |
| `agents.defaults.name` | Your display name |
| `agents.defaults.mode` | `host` (direct) or `sandbox` (Docker container) |
| `agents.defaults.thinkLevel` | Reasoning effort: `low` / `medium` / `high` / `xhigh` |
| `agents.defaults.showThinking` | Show reasoning in messages (default: false) |
| `agents.defaults.githubMcp` | Enable GitHub MCP server (web_search, issues, PRs) |
| `agents.list` | Per-agent overrides (model, mode, provider per chat) |
| `channels.telegram.enabled` | Telegram channel on/off |
| `channels.teams.enabled` | Teams channel on/off |
| `channels.discord.enabled` | Discord channel on/off |
| `sendErrorToUser` | Send error messages to user (default: false) |
| `tui.mode` | TUI mode override |
| `chats` | Registered chat groups (telegram/teams) |
| `plugins` | Installed plugins |
| `addons` | Registered addons (e.g. devtunnel) |
| `configVersion` | Config migration version (current: 3) |

## Slash commands (in-chat)

| Command | Description |
|---------|-------------|
| `/think [off\|low\|medium\|high\|xhigh]` | Set reasoning effort level |
| `/reasoning [on\|off]` | Show or hide reasoning/thinking output in messages |
| `/new` | Reset session — start fresh conversation |
| `/status` | Show agent status and config |
| `/capabilities` | Show available tools and skills |
| `/tasks` | List scheduled tasks |
| `/wiki [topic]` | Knowledge base — ingest, query, or maintain your wiki |
| `/help` | Show available commands |

## CLI commands

| Command | Description |
|---------|-------------|
| `nanoclaw init` | Initialize workspace and config |
| `nanoclaw start` | Start nanoclaw (background daemon + devtunnel if configured) |
| `nanoclaw stop` | Stop nanoclaw + devtunnel + agent children |
| `nanoclaw restart` | Stop then start |
| `nanoclaw status` | Show running status, service info, auth state |
| `nanoclaw doctor` | Full health check |
| `nanoclaw logs [-f]` | View logs (optionally follow) |
| `nanoclaw tui` | Interactive terminal chat |
| `nanoclaw tui --ask "question"` | Single query mode (non-interactive) |
| `nanoclaw tui --ask "q" --model claude-opus-4.6 --think high` | With model/think overrides |
| `nanoclaw channel add telegram` | Set up Telegram bot |
| `nanoclaw channel add teams` | Set up Teams bot (manifest + credentials) |
| `nanoclaw channel list` | List configured channels |
| `nanoclaw provider login` | Login to LLM provider |
| `nanoclaw provider list` | List available providers |
| `nanoclaw plugin install <path>` | Install a plugin |
| `nanoclaw plugin list` | List installed plugins |
| `nanoclaw addon list` | List registered addons |
| `nanoclaw config get [path]` | Read config value |
| `nanoclaw config set <path> <value>` | Set config value |
| `nanoclaw chat list` | List registered chats |
| `nanoclaw pair` | Generate pairing code for mobile apps |
| `nanoclaw mcp` | Manage MCP servers |
| `nanoclaw update` | Update nanoclaw to latest version |

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

Plus GitHub MCP tools (when `githubMcp` enabled): `web_search`, `web_fetch`, `issue_read`, `search_code`, etc.

## Authentication

NanoClaw resolves GitHub tokens in this priority:
1. Environment variables: `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`
2. `~/.copilot/` file-based auth (copilot CLI config)
3. SDK `useLoggedInUser` fallback (OS credential manager — Windows Credential Manager / macOS Keychain / Linux keyring)

To login: `nanoclaw provider login` or `copilot auth login`

## Plugin system

NanoClaw supports plugins (dual manifest for GHC + CC compatibility):

```bash
nanoclaw plugin install /path/to/plugin
nanoclaw plugin list
nanoclaw plugin remove <name>
nanoclaw plugin info <name>
```

Plugin directories: `~/.nanoclaw/plugins/`, `~/.copilot/plugins/`, `~/.claude/plugins/`

## Where to find documentation and source code

### Documentation (local)

```bash
# If installed globally via npm
ls $(npm root -g)/nanoclaw-github-copilot/docs/

# Key docs
cat $(npm root -g)/nanoclaw-github-copilot/docs/getting-started.md
cat $(npm root -g)/nanoclaw-github-copilot/docs/configuration.md
cat $(npm root -g)/nanoclaw-github-copilot/docs/troubleshooting.md
```

### Source code (GitHub)

Repository: `https://github.com/kenansun-dev/nanoclaw-github-copilot`
Upstream: `https://github.com/qwibitai/nanoclaw`

```bash
# Key source files
# Main entry point
cat $(npm root -g)/nanoclaw-github-copilot/src/index.ts

# Agent runner (GHC)
cat $(npm root -g)/nanoclaw-github-copilot/container/agent-runner-ghc/src/index.ts

# Config loader
cat $(npm root -g)/nanoclaw-github-copilot/src/config-loader.ts

# Slash commands
cat $(npm root -g)/nanoclaw-github-copilot/src/slash-commands.ts
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

**Change model:**
Edit `agents.defaults.model` in `nanoclaw.json`, then `nanoclaw restart`.

**Enable/disable thinking display:**
Use `/reasoning on` or `/reasoning off` in chat (persists to config).

**Change thinking level:**
Use `/think high` in chat (persists to config).

**Add a scheduled task:**
Use your `nanoclaw-schedule_task` MCP tool directly — no config edit needed.

**Install a plugin:**
`nanoclaw plugin install /path/to/plugin`

## Self-diagnosis — reading your own logs

```bash
# Last 50 lines
cat ~/.nanoclaw/logs/nanoclaw.log | tail -50

# Errors only
cat ~/.nanoclaw/logs/nanoclaw.log | grep -i 'error\|fatal' | tail -10

# Agent issues
cat ~/.nanoclaw/logs/nanoclaw.log | grep -i 'spawn\|exited\|agent' | tail -10

# Auth issues
cat ~/.nanoclaw/logs/nanoclaw.log | grep -i 'token\|auth\|license' | tail -10
```

### Common errors and fixes

| Error | Cause | Fix |
|-------|-------|-----|
| `Session was not created with authentication info` | Token not found / credential manager issue | `nanoclaw provider login` or set `GITHUB_TOKEN` env var |
| `Model does not support reasoning effort` | thinkLevel set for incompatible model | `/think off` or remove from per-agent config |
| `EADDRINUSE` | Port already in use (Teams webhook) | Kill old process: `lsof -i :3978` then kill |
| `Not licensed to use Copilot` | GitHub account doesn't have Copilot subscription | Login with licensed account |
| `Docker not running` | Container mode needs Docker | Switch to host mode in config |

## What you CAN do
- Run bash commands (host: permanent, container: temporary)
- Read/write files in your workspace
- Search the web (`web_search`, `web_fetch`)
- Send messages and files to users
- Schedule recurring tasks
- Read PDFs
- Edit your own config (host mode)
- Use slash commands (`/think`, `/reasoning`, `/new`, etc.)

## What you CANNOT do
- Access other groups' workspaces (isolated per group)
- Send messages to unregistered chats
- Access host filesystem in container mode

## What requires caution
- **Restarting yourself**: Tell the user to run `nanoclaw restart`. Do NOT try to restart from within the agent process.
- **Config changes**: Always validate JSON before writing. Bad config = nanoclaw won't start.
- **In container mode**: You cannot run nanoclaw CLI commands — only MCP tools work.
