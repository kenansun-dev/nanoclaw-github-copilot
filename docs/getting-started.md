# NanoClaw — Getting Started

## Quick Install

### Windows (PowerShell)
```powershell
irm https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.ps1 | iex
```

### Linux / macOS / WSL
```bash
curl -fsSL https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.sh | bash
```

The installer will:
1. Check Node.js 20+
2. Download and install NanoClaw from GitHub Release
3. Initialize workspace (`~/.nanoclaw/`)
4. Guide you through authentication

## Prerequisites

- **Node.js 20+** — `winget install OpenJS.NodeJS` (Windows) or `brew install node` (macOS)
- **GitHub Copilot subscription** — any plan that includes Copilot
- **Docker** (optional) — only needed for sandbox mode

## Manual Setup

If you prefer not to use the one-line installer:

```bash
# Download from GitHub Release
npm install -g nanoclaw-github-copilot-0.0.1-alpha.tgz

# Initialize workspace
nanoclaw init

# Authenticate
nanoclaw auth login

# Check setup
nanoclaw doctor

# Start
nanoclaw start
```

## Configuration

Edit `~/.nanoclaw/nanoclaw.json`:

```json
{
  "agents": {
    "defaults": {
      "model": "github-copilot/claude-sonnet-4",
      "name": "Andy",
      "mode": "host"
    }
  },
  "channels": {
    "telegram": { "enabled": true, "botToken": "YOUR_BOT_TOKEN" },
    "teams": { "enabled": false }
  }
}
```

See [configuration.md](configuration.md) for full reference.

## Host Mode vs Sandbox Mode

| | Host Mode | Sandbox Mode |
|---|---|---|
| Docker required | No | Yes |
| Security | Agent runs on host | Agent runs in container |
| Default on | Windows | Linux/macOS |
| Setup | Just start | `nanoclaw sandbox build` first |

Windows defaults to host mode. To use sandbox mode, install Docker and set `"mode": "sandbox"` in config.

## Adding Channels

### Telegram
1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Set bot token in `nanoclaw.json` or `.env`
3. Enable: `"telegram": { "enabled": true }`
4. Restart: `nanoclaw restart`
5. Send a message to your bot — it will show pairing instructions

### Teams
Run the setup script:
```powershell
# Windows
$scriptPath = Join-Path (npm root -g) "nanoclaw-github-copilot\scripts\setup-teams.ps1"
powershell -ExecutionPolicy Bypass -File $scriptPath
```

```bash
# Linux
$(npm root -g)/nanoclaw-github-copilot/scripts/setup-teams.sh
```

Prerequisites: Azure CLI (`az login`) + DevTunnel CLI (`devtunnel login`).

## Slash Commands

| Command | Description |
|---------|-------------|
| `/think [level]` | Set reasoning effort (off/low/medium/high/xhigh) |
| `/new` | Reset session — fresh conversation |
| `/help` | Show available commands |
| `/tasks` | List scheduled tasks |
| `/status` | Show agent status |

## File Transfer

- **Send files to agent:** Send a document in Telegram/Teams — it's downloaded to the agent workspace
- **Agent sends files:** Agent uses `send_file` tool to send files back to you

## Updating

```bash
nanoclaw update
```

Downloads latest from GitHub Release automatically. Config and data are preserved.

## Troubleshooting

See [troubleshooting.md](troubleshooting.md).

Common issues:
- `nanoclaw doctor` — checks all dependencies
- `nanoclaw logs -f` — live logs
- `nanoclaw status` — service status
