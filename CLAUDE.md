# NanoClaw (GitHub Copilot Fork)

Personal AI assistant powered by GitHub Copilot SDK. See [README.md](README.md) for philosophy and setup.

## Quick Context

Single Node.js process with channel system. Channels (Telegram, Teams, Discord) self-register at startup. Messages route to agents via GitHub Copilot SDK (GHC) or Claude Agent SDK (CC). Two runtime modes:
- **Host mode**: agent-runner runs as child process on host
- **Sandbox mode**: agent-runner runs in Docker container

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

GitHub Copilot token resolution order:
1. Environment variables: `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`
2. `~/.copilot/config.json` — copilot CLI file storage
3. SDK `useLoggedInUser` — OS credential manager (keychain/Windows Credential Manager)

Login: `nanoclaw provider login github-copilot`

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
      "model": "claude-sonnet-4.5",
      "mode": "host",
      "thinkLevel": "low",
      "showThinking": false
    }
  }
}
```

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
