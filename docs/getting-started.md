# NanoClaw — Getting Started

## Quick Start

```bash
# 1. Install
npm install -g nanoclaw-copilot

# 2. Initialize workspace
nanoclaw init

# 3. Edit config
nano ~/.nanoclaw/nanoclaw.json    # enable channels
nano ~/.nanoclaw/.env              # add credentials

# 4. Check setup
nanoclaw doctor

# 5. Build agent container
nanoclaw sandbox build

# 6. Start
nanoclaw start
```

## Prerequisites

- **Node.js 20+**
- **Docker** (for agent sandbox)
- **GitHub Copilot subscription**

## Workspace

Default: `~/.nanoclaw/`

```
~/.nanoclaw/
├── nanoclaw.json     Main config
├── .env              Credentials (tokens, secrets)
├── AGENT.md          Agent personality
├── skills/           Custom skills
├── state/            Runtime data (DB, groups)
├── logs/             Logs
└── docs/             Documentation
```

## Channels

### Telegram
1. Create bot via @BotFather → get token
2. Add to `.env`: `TELEGRAM_BOT_TOKEN=xxx`
3. In `nanoclaw.json`: `"channels": { "telegram": { "enabled": true } }`
4. Start nanoclaw, send `/chatid` to bot, register the chat

### Teams
1. Create Azure Bot + App Registration (multi-tenant)
2. Add to `.env`: `MSTEAMS_APP_ID`, `MSTEAMS_APP_PASSWORD`
3. Set `MSTEAMS_TENANT_ID` to **app's home tenant** in `.env` or config
4. Start tunnel: `devtunnel host -p 3978 --allow-anonymous`
5. Set Azure Bot messaging endpoint to tunnel URL + `/api/messages`
6. Upload Teams app manifest zip
7. Register chat via `nanoclaw chat add`

## Common Commands

```bash
nanoclaw status       # Check if running
nanoclaw logs -f      # Follow logs
nanoclaw doctor       # Health check
nanoclaw chat list    # See registered chats
nanoclaw chat pending # See unregistered chats waiting
```
