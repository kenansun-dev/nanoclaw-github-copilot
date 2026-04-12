<p align="center">
  <img src="assets/nanoclaw-logo.png" alt="NanoClaw" width="400">
</p>

<p align="center">
  <b>GitHub Copilot Edition</b> — NanoClaw powered by GitHub Copilot SDK instead of Claude Code.
</p>

<p align="center">
  <a href="https://github.com/kenans/nanoclaw-github-copilot">GitHub</a>&nbsp; · &nbsp;
  <a href="docs/getting-started.md">Getting Started</a>&nbsp; · &nbsp;
  <a href="docs/configuration.md">Configuration</a>&nbsp; · &nbsp;
  <a href="CHANGELOG.md">Changelog</a>
</p>

---

## What is this?

A fork of [NanoClaw](https://github.com/qwibitai/nanoclaw) that replaces Claude Code with **GitHub Copilot SDK** as the agent runtime. Same container-isolated architecture, different AI engine.

**What's added:**
- **GitHub Copilot SDK** as agent runtime (no Anthropic subscription needed)
- **Microsoft Teams** channel (+ Telegram from upstream)
- **`nanoclaw` CLI** — init, start, stop, doctor, config, etc.
- **`~/.nanoclaw/` workspace** — config and code fully separated
- **`nanoclaw.json`** — declarative config file
- **MCP OAuth** — PRM auto-discovery + device code flow

## Install

**Windows (PowerShell):**
```powershell
irm https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.ps1 | iex
```

**Linux / macOS / WSL:**
```bash
curl -fsSL https://raw.githubusercontent.com/kenans/nanoclaw-github-copilot/main/install.sh | bash
```

**Requirements:** Node.js 20+, GitHub Copilot subscription. Docker optional (for sandbox mode).

## Quick Start

```bash
# 1. Initialize workspace
nanoclaw init

# 2. Authenticate with GitHub Copilot
nanoclaw auth login

# 3. Check setup
nanoclaw doctor

# 4. Start
nanoclaw start
```

## How it works

```
You (Telegram / Teams)
  → NanoClaw (message routing + channel management)
    → Docker container (isolated sandbox)
      → GitHub Copilot SDK (AI agent)
        → Tools (bash, files, web, MCP)
      ← Response
    ← Container output
  ← Reply to you
```

Each chat gets its own isolated container. Agents can run shell commands, read/write files, search the web, and use MCP tools — all sandboxed.

## Configuration

All config lives in `~/.nanoclaw/`:

```
~/.nanoclaw/
├── nanoclaw.json     Main config (channels, model, sandbox settings)
├── .env              Credentials (bot tokens, API keys)
├── AGENT.md          Agent personality
├── skills/           Custom skills
├── state/            Runtime data
├── logs/             Logs
└── docs/             Documentation
```

See [docs/configuration.md](docs/configuration.md) for full reference.

## CLI

```
nanoclaw init          Initialize workspace
nanoclaw start/stop    Service management
nanoclaw doctor        Check dependencies
nanoclaw config        View/edit config
nanoclaw provider      Auth management (GitHub Copilot login)
nanoclaw channel       Channel management
nanoclaw chat          Chat pairing
nanoclaw sandbox       Container management
nanoclaw update        Self-update
```

## Channels

| Channel | Status | Setup |
|---------|--------|-------|
| Telegram | ✅ | Create bot via @BotFather, add token |
| Teams | ✅ | Azure Bot + App Registration ([guide](docs/getting-started.md#teams)) |

## Differences from original NanoClaw

| | Original NanoClaw | This Fork |
|---|---|---|
| Agent runtime | Claude Code (Anthropic) | GitHub Copilot SDK |
| Auth | Anthropic API key | GitHub Copilot (SSO / token) |
| Config | Code-based (.env only) | `nanoclaw.json` workspace |
| CLI | Through Claude Code `/setup` | `nanoclaw` CLI |
| Teams | Not included | Built-in |

## Update

```bash
nanoclaw update
# or
npm update -g nanoclaw-github-copilot
```

## License

MIT — see [LICENSE](LICENSE)

---

Based on [NanoClaw](https://github.com/qwibitai/nanoclaw) by [Qwibit](https://qwibit.ai).
