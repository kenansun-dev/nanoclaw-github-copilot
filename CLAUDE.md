# NanoClaw

Personal AI assistant supporting two provider backends: **GitHub Copilot SDK (GHC)** and **Claude Code / Anthropic SDK (CC)**. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process with channel system. Channels (Telegram, Teams, Discord) self-register at startup. Messages route to agents via the configured provider. Two runtime modes:
- **Host mode**: agent-runner runs as child process on host
- **Sandbox mode**: agent-runner runs in Docker container

Provider is set per-agent via `agents.defaults.provider` or `agents.list[].provider`.

Each group has isolated filesystem and memory.

## Key Files

| File | Purpose |
|------|---------|
| `src/index.ts` | Orchestrator: state, message loop, agent invocation |
| `src/host-runner.ts` | Spawns host-mode agent processes |
| `src/container-runner.ts` | Spawns agent containers with mounts |
| `src/channels/registry.ts` | Channel registry (self-registration) |
| `src/config-extensions.ts` | Token resolution, provider detection |
| `src/slash-commands.ts` | /think, /reasoning, /new, /help commands |
| `src/ipc.ts` | IPC watcher and task processing |
| `src/config-loader.ts` | Config schema and persistence |
| `container/agent-runner-ghc/` | GHC SDK agent runner |
| `container/agent-runner/` | CC SDK agent runner |
| `groups/{name}/COPILOT.md` | Per-group memory (isolated) |

## Auth

**GHC (GitHub Copilot) mode:**
1. Environment variables: `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`
2. `~/.copilot/config.json` — copilot CLI file storage
3. SDK `useLoggedInUser` — OS credential manager (keychain/Windows Credential Manager)

Login: `nanoclaw provider login github-copilot`

**CC (Claude Code / Anthropic) mode:**
1. Environment variable: `ANTHROPIC_API_KEY`
2. Credential proxy on host (port 18080 by default) — proxies auth to container
3. `~/.claude/credentials.json` or `.env` file

Login: `nanoclaw provider login anthropic` or set `ANTHROPIC_API_KEY` in `~/.nanoclaw/.env`

## Slash Commands

| Command | Purpose |
|---------|---------|
| `/think off\|low\|medium\|high\|xhigh` | Set reasoning effort level |
| `/reasoning on\|off` | Show/hide thinking output in messages |
| `/new` | Reset session |
| `/help` | Show available commands |
| `/tasks` | List scheduled tasks |
| `/capabilities` | Show available tools |

## CLI

```bash
nanoclaw start / stop / restart / dev / status / logs
nanoclaw tui                          # Interactive terminal chat
nanoclaw tui --ask "question"          # Single query
nanoclaw tui --ask "q" --model claude-sonnet-4.6 --think high
nanoclaw provider login github-copilot # Auth login
nanoclaw channel teams --setup         # Teams setup
nanoclaw doctor                        # Health check
```

## Config (nanoclaw.json)

```json
{
  "agents": {
    "defaults": {
      "provider": "github-copilot",
      "model": "claude-sonnet-4.5",
      "mode": "host",
      "thinkLevel": "low",
      "showThinking": false
    }
  }
}
```

Provider options: `"github-copilot"` (GHC) or `"anthropic"` (CC).
Mode options: `"host"` or `"sandbox"` (Docker container).

## Development

```bash
npm run build        # Compile TypeScript
npm test             # Run tests
npm run dev          # Run with hot reload
```

Service management:
```bash
systemctl --user start/stop/restart nanoclaw   # Linux
nanoclaw service install                        # Install as service
```

## Repo

- GitHub: https://github.com/kenansun-dev/nanoclaw-github-copilot
- Upstream: https://github.com/qwibitai/nanoclaw
- Push via GitHub App token (App ID: 3347459)
