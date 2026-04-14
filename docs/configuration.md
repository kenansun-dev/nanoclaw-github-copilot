# NanoClaw Configuration Reference

## nanoclaw.json

Located at `~/.nanoclaw/nanoclaw.json`.

### agents

```json
"agents": {
  "defaults": {
    "model": "github-copilot/claude-sonnet-4",
    "name": "Andy",
    "triggerWord": "@Andy",
    "hasOwnNumber": false,
    "mode": "host",
    "thinkLevel": "medium",
    "githubMcp": true
  },
  "list": []
}
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model` | string | `github-copilot/claude-sonnet-4` | Model in `provider/model` format |
| `name` | string | `Andy` | Bot display name and trigger word |
| `triggerWord` | string | `@Andy` | Trigger pattern for group chats |
| `hasOwnNumber` | boolean | `false` | Whether bot has its own phone number |
| `mode` | `host` \| `sandbox` | `sandbox` (Linux), `host` (Windows) | Agent execution mode |
| `thinkLevel` | `low` \| `medium` \| `high` \| `xhigh` | (none) | Reasoning effort level. Set via `/think` command |
| `showThinking` | boolean | `false` | Show reasoning/thinking in channel messages. Set via `/reasoning on\|off` |
| `githubMcp` | boolean | `true` | Register GitHub MCP server (web_search, issues, PRs) |

**Mode:**
- `host` — runs agent-runner directly on the host (no Docker needed)
- `sandbox` — runs agent-runner in a Docker container (more secure, requires Docker)

**Multi-agent:** Add entries to `agents.list[]` with different models/configs. Each chat can be bound to a specific agent via `chats[jid].agentId`.

### channels

```json
"channels": {
  "telegram": {
    "enabled": true,
    "botToken": "123456:ABC..."
  },
  "teams": {
    "enabled": true,
    "appId": "...",
    "appPassword": "...",
    "tenantId": "...",
    "webhookPort": 3978,
    "authMode": "secret"
  },
  "discord": {
    "enabled": false,
    "botToken": ""
  }
}
```

Bot tokens can also be set in `.env`:
```
TELEGRAM_BOT_TOKEN=123456:ABC...
MSTEAMS_APP_ID=...
MSTEAMS_APP_PASSWORD=...
MSTEAMS_TENANT_ID=...
```

### mcp

External MCP servers loaded by the agent.

```json
"mcp": {
  "servers": {
    "my-server": {
      "type": "local",
      "command": "node",
      "args": ["path/to/server.js"],
      "tools": ["*"]
    }
  }
}
```

Built-in MCP servers (auto-discovered from `mcp-servers/` directory):
- `nanoclaw` — IPC tools (send_message, send_file, react, schedule_task, etc.)
- `nanoclaw-pdf` — PDF reader (read_pdf)
- GitHub MCP — web_search, issues, PRs (enabled via `githubMcp: true`)

### chats

Registered chats (managed by `nanoclaw pair` or auto-pairing).

```json
"chats": {
  "tg:12345": {
    "name": "My Chat",
    "isMain": true,
    "requiresTrigger": false
  }
}
```

### pairing

```json
"pairing": {
  "mode": "open",
  "notifyChat": "tg:12345"
}
```

| Mode | Description |
|------|-------------|
| `open` | Auto-register new chats |
| `prompt` | Ask admin to approve |
| `allowlist` | Only pre-configured chats |
| `disabled` | No new chats |

### security

```json
"security": {
  "allowedSenders": {
    "default": { "allow": "*", "mode": "trigger" },
    "chats": {
      "tg:12345": { "allow": ["user1", "user2"], "mode": "drop" }
    }
  }
}
```

### sendErrorToUser

```json
"sendErrorToUser": true
```

When `true`, agent errors are sent to the user (e.g., "Unable to process your message. Docker is not running."). Default: `false`.

### Other fields

| Field | Default | Description |
|-------|---------|-------------|
| `logLevel` | `info` | Log level (debug, info, warn, error) |
| `timezone` | system | Timezone for timestamps (e.g., `Asia/Shanghai`) |
| `credentialProxy.port` | `18080` | CC credential proxy port |

## .env

Located at `~/.nanoclaw/.env`. Credentials that shouldn't be in nanoclaw.json.

```
# GitHub Copilot (alternative to `copilot login`)
COPILOT_GITHUB_TOKEN=ghu_xxxxx

# Telegram
TELEGRAM_BOT_TOKEN=123456:ABC...

# Teams
MSTEAMS_APP_ID=...
MSTEAMS_APP_PASSWORD=...
MSTEAMS_TENANT_ID=...
```

## Slash Commands

Available in all channels:

| Command | Description |
|---------|-------------|
| `/think [off\|low\|medium\|high\|xhigh]` | Set reasoning effort level |
| `/reasoning [on\|off]` | Show or hide reasoning/thinking output in messages |
| `/new` | Reset session — start fresh conversation |
| `/help` | Show available commands |
| `/tasks` | List scheduled tasks |
| `/status` | Show agent status |
| `/capabilities` | Show available tools and skills |
| `/wiki [topic]` | Knowledge base — ingest, query, or maintain your wiki |

## CLI Commands

```bash
nanoclaw init                    # Initialize workspace
nanoclaw start                   # Start (background daemon + devtunnel)
nanoclaw stop                    # Stop all processes
nanoclaw restart                 # Stop + start
nanoclaw status                  # Quick health check
nanoclaw doctor                  # Full dependency check
nanoclaw logs [-f]               # View/follow logs
nanoclaw tui                     # Interactive terminal chat
nanoclaw tui --ask "question"    # Single query (non-interactive)
nanoclaw tui --ask "q" --model claude-opus-4.6 --think high  # With overrides
nanoclaw channel add telegram    # Set up Telegram
nanoclaw channel add teams       # Set up Teams
nanoclaw provider login          # Login to LLM provider
nanoclaw plugin list             # List installed plugins
nanoclaw config get [path]       # Read config
nanoclaw config set <path> <val> # Set config
```

## Config Version

Current: `configVersion: 3`. NanoClaw auto-migrates older configs on startup (v0→v1→v2→v3).
