---
name: self-knowledge
description: Understand your own configuration, capabilities, architecture, and how to help users configure or extend you. Use when asked about how you work, what you can do, your settings, plugins/marketplaces, installing/uninstalling plugins, or when users want to change your configuration (self-bootstrapping). Trigger keywords include: plugin, plugins, marketplace, install plugin, uninstall plugin, extend yourself, add capability, nanoclaw_plugin, nanoclaw_control, configure, restart daemon.
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

| Field                          | What it controls                                      |
| ------------------------------ | ----------------------------------------------------- |
| `agents.defaults.provider`     | LLM provider (e.g. `github-copilot`, `anthropic`)     |
| `agents.defaults.model`        | Model name (e.g. `claude-sonnet-4.5`)                 |
| `agents.defaults.name`         | Your display name                                     |
| `agents.defaults.mode`         | `host` (direct) or `sandbox` (Docker container)       |
| `agents.defaults.thinkLevel`   | Reasoning effort: `low` / `medium` / `high` / `xhigh` |
| `agents.defaults.showThinking` | Show reasoning in messages (default: false)           |
| `agents.defaults.githubMcp`    | Enable GitHub MCP server (web_search, issues, PRs)    |
| `agents.list`                  | Per-agent overrides (model, mode, provider per chat)  |
| `channels.telegram.enabled`    | Telegram channel on/off                               |
| `channels.teams.enabled`       | Teams channel on/off                                  |
| `channels.discord.enabled`     | Discord channel on/off                                |
| `sendErrorToUser`              | Send error messages to user (default: false)          |
| `tui.mode`                     | TUI mode override                                     |
| `chats`                        | Registered chat groups (telegram/teams)               |
| `plugins`                      | Installed plugins                                     |
| `addons`                       | Registered addons (e.g. devtunnel)                    |
| `configVersion`                | Config migration version (current: 3)                 |

## Slash commands (in-chat)

> **Source of truth**: `src/slash-commands.ts` exports the `COMMANDS` array.
> Run `/help` in chat for the live auto-generated list — this table is a
> snapshot and may lag the registry.

| Command                                                      | Description                                                       |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| `/think [off\|low\|medium\|high\|xhigh]`                     | Set reasoning effort level                                        |
| `/reasoning [on\|off\|flash]`                                | Show, hide, or flash-stream reasoning in messages                 |
| `/new` (alias `/reset`)                                      | Reset session — start fresh conversation                          |
| `/status`                                                    | Show agent status, auth, models, channels (file-only, <50ms)      |
| `/capabilities`                                              | Show available tools and skills                                   |
| `/tasks`                                                     | List scheduled tasks                                              |
| `/wiki [topic]`                                              | Knowledge base — ingest, query, or maintain your wiki             |
| `/model [id] [--default]`                                    | Show or set active model (per-session, or `--default` for global) |
| `/models`                                                    | List available models from the provider catalog                   |
| `/mcp`                                                       | List configured MCP servers (parity with CC `/mcp`)               |
| `/plugin [list\|install\|remove\|info\|marketplace\|reload]` | Manage plugins from chat                                          |
| `/help`                                                      | Show all available commands (auto-generated from `COMMANDS`)      |

## CLI commands

| Command                                                       | Description                                                                                         |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `nanoclaw init`                                               | Initialize workspace and config                                                                     |
| `nanoclaw start`                                              | Start nanoclaw (background daemon + devtunnel if configured)                                        |
| `nanoclaw stop`                                               | Stop nanoclaw + devtunnel + agent children                                                          |
| `nanoclaw restart`                                            | Stop then start                                                                                     |
| `nanoclaw status`                                             | Show running status, service info, auth state                                                       |
| `nanoclaw doctor`                                             | Full health check                                                                                   |
| `nanoclaw logs [-f]`                                          | View logs (optionally follow)                                                                       |
| `nanoclaw tui`                                                | Interactive terminal chat                                                                           |
| `nanoclaw tui --ask "question"`                               | Single query mode (non-interactive)                                                                 |
| `nanoclaw tui --ask "q" --model claude-opus-4.6 --think high` | With model/think overrides                                                                          |
| `nanoclaw channel add telegram`                               | Set up Telegram bot                                                                                 |
| `nanoclaw channel add teams --setup-manifest`                 | Generate Teams App manifest zip                                                                     |
| `nanoclaw channel add teams --setup-manifest --account daily` | Generate manifest for specific account                                                              |
| `nanoclaw channel list`                                       | List configured channels                                                                            |
| `nanoclaw provider login`                                     | Login to LLM provider                                                                               |
| `nanoclaw provider list`                                      | List available providers                                                                            |
| `nanoclaw plugin install <spec>`                              | Install a plugin (spec: `name@marketplace`, `owner/repo[:subdir]`, git URL, or local path)          |
| `nanoclaw plugin list`                                        | List installed plugins                                                                              |
| `nanoclaw plugin remove <name>`                               | Uninstall a plugin (removes from `plugins.enabled[]` + deletes dir)                                 |
| `nanoclaw plugin marketplace add <source>`                    | Register a plugin marketplace                                                                       |
| `nanoclaw plugin marketplace list`                            | List registered marketplaces                                                                        |
| `nanoclaw plugin marketplace browse [name]`                   | Browse plugins available in a marketplace                                                           |
| `nanoclaw plugin marketplace remove <name>`                   | Unregister a marketplace                                                                            |
| `nanoclaw addon list`                                         | List registered addons                                                                              |
| `nanoclaw config get [path]`                                  | Read config value                                                                                   |
| `nanoclaw config set <path> <value>`                          | Set config value                                                                                    |
| `nanoclaw chat list`                                          | List registered chats                                                                               |
| `nanoclaw pair`                                               | Generate pairing code for mobile apps                                                               |
| `nanoclaw mcp add <name> <url>`                               | Add an MCP server (auto-reloads daemon, **no restart needed**)                                      |
| `nanoclaw mcp remove <name>`                                  | Remove an MCP server (auto-reloads daemon)                                                          |
| `nanoclaw mcp list`                                           | List configured MCP servers                                                                         |
| `nanoclaw reload`                                             | Hot-reload `nanoclaw.json` / `mcp.json` without restart (SIGUSR2 on POSIX, trigger file on Windows) |
| `nanoclaw update`                                             | Update nanoclaw to latest version                                                                   |

### MCP changes are hot — do not tell users to restart

When a user wants to add an MCP server:

1. **Use `nanoclaw mcp add <name> <url>`** — it writes to
   `nanoclaw.json` AND signals the running daemon to reload its
   in-memory config. The new server is live on the next agent turn.
2. Do NOT recommend editing `~/.mcp.json` / `.cursor/mcp.json` /
   `.vscode/mcp.json`. Those belong to other tools; NanoClaw's MCP
   config lives at `~/.nanoclaw/nanoclaw.json` (under `mcp.servers`)
   and `~/.nanoclaw/mcp.json`.
3. Do NOT tell the user to run `nanoclaw restart` for an MCP change.
   The CLI already handled the reload. Restart is a sledgehammer.
4. If the user manually edited `~/.nanoclaw/mcp.json` or `nanoclaw.json`
   without using the CLI, run `nanoclaw reload` (or call
   `nanoclaw_control` with `action: reload_config` from the main chat).

**The only changes that genuinely need `nanoclaw restart`**: channel
auth tokens (Telegram bot token, Teams creds), port bindings, sandbox
image rebuilds, and updates to nanoclaw itself. Try `reload` first if
in doubt.

## Architecture

### Processes

NanoClaw runs as multiple processes:

1. **Main process** (`node dist/index.js`) — always running
   - Listens for messages from channels (Telegram, Teams, TUI)
   - Manages sessions, groups, scheduled tasks
   - Spawns agent processes on demand

2. **Agent process** (child of main) — spawned per query
   - Runs `agent-runner-ghc` (GHC SDK) or `agent-runner` (CC SDK)
   - Agent-runner starts **Copilot CLI** as a subprocess (headless, stdio)
   - CLI does the actual LLM inference, tool execution, MCP calls
   - Communicates results back via stdout markers

3. **DevTunnel** (optional, separate process) — for Teams webhook

### Modes

- **Host mode** (`mode: "host"`): agent-runner runs as direct child process on the host machine. Has access to host filesystem, tools, credential manager.
- **Sandbox mode** (`mode: "sandbox"`): agent-runner runs inside a Docker container. Isolated filesystem, limited access. Needs token passed via env var.

### Message flow

```
User → Channel (Telegram/Teams) → Main process → Spawn agent-runner → CLI subprocess → LLM
                                                                     ← stdout markers ←
                                 ← Send reply via channel ←
```

### Key directories

- `~/.nanoclaw/` — workspace root
- `~/.nanoclaw/data/sessions/{group}/` — per-group session data
- `~/.nanoclaw/groups/{group}/` — per-group workspace (files, uploads)
- `~/.nanoclaw/logs/` — daily log files
- `~/.nanoclaw/credentials/` — MCP tokens, cached auth

## Your MCP tools

These are your custom tools (provided by NanoClaw IPC MCP server):

| Tool                      | What it does                                                          |
| ------------------------- | --------------------------------------------------------------------- |
| `nanoclaw-send_message`   | Send a text message to the user/group                                 |
| `nanoclaw-send_file`      | Send a file to the user (Telegram: as document)                       |
| `nanoclaw-schedule_task`  | Schedule a recurring or one-time task                                 |
| `nanoclaw-list_tasks`     | List all scheduled tasks                                              |
| `nanoclaw-pause_task`     | Pause a scheduled task                                                |
| `nanoclaw-resume_task`    | Resume a paused task                                                  |
| `nanoclaw-cancel_task`    | Cancel and delete a task                                              |
| `nanoclaw-update_task`    | Update an existing task                                               |
| `nanoclaw-register_group` | Register a new chat/group (main only)                                 |
| `nanoclaw-react`          | React to a message with an emoji                                      |
| `nanoclaw-pdf-read_pdf`   | Extract text from a PDF file                                          |
| `nanoclaw_plugin`         | List/install/uninstall plugins (mutating actions = main chat only)    |
| `nanoclaw_control`        | Restart daemon, reload config, or set a config field (main chat only) |

Plus GitHub MCP tools (when `githubMcp` enabled): `web_search`, `web_fetch`, `issue_read`, `search_code`, etc.

**Note:** GitHub MCP tools are injected at runtime via code, NOT configured in `~/.mcp.json` or `~/.nanoclaw/mcp.json`. The `.mcp.json` file may be empty — that's normal. To check available tools at runtime, ask the agent to list its tools.

## Authentication

NanoClaw resolves GitHub tokens in this priority:

1. Environment variables: `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`
2. `~/.copilot/` file-based auth (copilot CLI config)
3. SDK `useLoggedInUser` fallback (OS credential manager — Windows Credential Manager / macOS Keychain / Linux keyring)

To login: `nanoclaw provider login` or `copilot auth login`

## Remote MCP with Azure AD auth

Remote MCP servers that require Azure AD authentication can be configured with an `auth` block in `nanoclaw.json` or `mcp.json`:

```json
"devbox": {
  "type": "http",
  "url": "https://devbox.microsoft.com/mcp",
  "auth": {
    "provider": "azure",
    "resource": "https://devbox.microsoft.com"
  }
}
```

Token acquisition: cached token → refresh → `az account get-access-token` → `az login --use-device-code` → built-in device code flow.

If auth is needed and the user hasn't logged in, the agent will receive a `loginPrompt` with instructions to guide the user.

## Plugin system

NanoClaw supports plugins (dual manifest for GHC + CC compatibility). A
plugin is a directory bundling skills + MCP servers + agents declared
via a `plugin.json` manifest (root or `.claude-plugin/plugin.json`).

### Declarative config (`plugins` block in `nanoclaw.json`)

```json
{
  "plugins": {
    "enabled": [
      { "name": "workiq", "source": "microsoft/work-iq" },
      { "name": "local-tool", "source": "/abs/path/to/plugin", "autoInstall": false }
    ],
    "marketplaces": [{ "name": "acme", "source": "https://github.com/acme/marketplace" }],
    "directories": ["~/.nanoclaw/plugins"]
  }
}
```

On daemon startup, every entry in `plugins.enabled[]` is auto-installed
if the plugin's target directory does not yet exist (idempotent).
`autoInstall: false` skips fetch — useful for marking a plugin as
declared on this machine but pre-populated externally.

### Source spec formats (parseInstallSpec accepts all of these)

- `name@marketplace` — plugin from a registered marketplace catalog
- `owner/repo` or `owner/repo:subdir` — GitHub shorthand
- `https://...git`, `git@...` — full git URL
- `/abs/path` or `./relative` or `~/path` — local directory

### CLI

```bash
nanoclaw plugin install <spec>
nanoclaw plugin list
nanoclaw plugin remove <name>
nanoclaw plugin marketplace add|list|browse|remove
```

### MCP tool: `nanoclaw_plugin`

From inside chat, the agent can call `nanoclaw_plugin` directly:

- `action: list` — enumerate installed plugins (works in any chat)
- `action: install` with `source` — main chat only
- `action: uninstall` with `name` — main chat only
- `action: marketplace_list` — enumerate marketplaces (works in any chat)

After installing a plugin that ships **MCP servers**, restart the
daemon with `nanoclaw_control(restart)` so the new servers register.
Pure-skill plugins are picked up on the next agent invocation without
a restart.

Plugin directories searched: `~/.nanoclaw/plugins/`,
`~/.copilot/plugins/`, `~/.claude/plugins/`.

## Logging

- Logs written to `~/.nanoclaw/logs/nanoclaw-YYYY-MM-DD.log` (daily rotation)
- Logs older than 7 days are gzip archived (`.log.gz`), not deleted
- Format: `[timestamp] LEVEL message key=value key=value`
- Tokens automatically scrubbed (`gho_****`, `Bearer ****`, etc.)
- Stack traces (err) stay multi-line

## File transfer (Teams)

- Teams DM: FileConsentCard flow (user accepts → file uploaded to OneDrive)
- Teams group: text notification with file path
- Receiving files: attachments downloaded to `groups/{folder}/uploads/`
- Requires `supportsFiles: true` in Teams manifest

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

| Error                                              | Cause                                            | Fix                                                     |
| -------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------- |
| `Session was not created with authentication info` | Token not found / credential manager issue       | `nanoclaw provider login` or set `GITHUB_TOKEN` env var |
| `Model does not support reasoning effort`          | thinkLevel set for incompatible model            | `/think off` or remove from per-agent config            |
| `EADDRINUSE`                                       | Port already in use (Teams webhook)              | Kill old process: `lsof -i :3978` then kill             |
| `Not licensed to use Copilot`                      | GitHub account doesn't have Copilot subscription | Login with licensed account                             |
| `Docker not running`                               | Container mode needs Docker                      | Switch to host mode in config                           |

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

## Self-troubleshooting

When something isn't working, diagnose it yourself before asking the user.

### "Channel X not responding" (e.g. Teams works but Telegram doesn't, or vice versa)

1. Check service is running: `nanoclaw status` or read PID file
2. Read recent logs: `tail -50 ~/.nanoclaw/logs/nanoclaw-$(date +%Y-%m-%d).log`
3. Look for: `ERROR`, `auth`, `retry`, `exit`, `crash`, `timeout`
4. Check if messages are arriving: search logs for `Telegram message stored` or `Teams` + the chat JID
5. Check if agent is spawning: search for `Spawning host agent`
6. Check if agent is returning output: search for `Agent output`
7. Common causes:
   - **Retry backoff** — previous error left agent in retry loop (look for `Scheduling retry`)
   - **devtunnel down** — Teams messages can't reach the bot (check `devtunnel` process)
   - **Token expired** — auth failure prevents agent from starting
   - **Session stuck** — `/new` to reset session

### "Agent has no tools / MCP not working"

1. Check GitHub MCP: search logs for `Using GitHub token` — if missing, token not found
2. Check MCP config: read `~/.nanoclaw/mcp.json` and `nanoclaw.json` mcp.servers
3. GitHub MCP tools are runtime-injected, NOT in `.mcp.json` — check by asking the agent to list tools
4. If `enableConfigDiscovery` is on, CLI also reads `~/.mcp.json`

### "Bot not replying in one channel but works in another"

1. Check channel registration: `nanoclaw chat list`
2. Check if the chat JID exists in logs
3. TUI works independently — it doesn't go through the service if in direct mode
4. Each channel has its own message processing — one can fail without affecting others

### General diagnostic commands

```bash
nanoclaw status          # service + auth + channels
nanoclaw doctor          # full health check
nanoclaw logs -f         # live log tail
nanoclaw chat list       # registered chats
```

### Proactive troubleshooting

When the user reports a problem (e.g. "Teams not replying", "bot stuck"), don't just describe possible causes — **run the diagnostic commands yourself** and report findings:

```bash
# Step 1: Check service status
nanoclaw status

# Step 2: Check recent errors in log
cat ~/.nanoclaw/logs/nanoclaw*.log | grep -i 'error\|fatal\|retry\|failed' | tail -10

# Step 3: Check if agent is spawning and completing
cat ~/.nanoclaw/logs/nanoclaw*.log | grep -i 'spawning\|completed\|exited\|timeout' | tail -10

# Step 4: Check auth
cat ~/.nanoclaw/logs/nanoclaw*.log | grep -i 'token\|auth\|license' | tail -5
```

Report what you find, then suggest fixes. Don't ask the user to run commands — **you run them**.
