# Changelog

All notable changes to NanoClaw will be documented in this file.

## [Copilot Edition] — 2026-03-26

Fork of NanoClaw with GitHub Copilot SDK replacing Claude Code.

### Added
- **GitHub Copilot SDK** as agent runtime (replacing Claude Code / Anthropic SDK)
- **Microsoft Teams channel** with certificate + client secret auth support
- **Workspace system** (`~/.nanoclaw/`) — config and code fully separated
- **`nanoclaw.json`** — declarative config file for all settings
- **CLI** (`nanoclaw`) — init, start, stop, doctor, config, provider, channel, chat, sandbox
- **Chat pairing** — CLI + config + auto-approve modes
- **MCP support** — inline servers in nanoclaw.json + auto-merge workspace mcp.json
- **MCP OAuth** — PRM auto-discovery + device code flow for remote MCP servers (workaround for GHC CLI bug #1967)
- **mcporter integration** — supported as MCP proxy/aggregator for managing remote MCP auth
- **Copilot SDK MCP** — SDK passes mcpServers to CLI subprocess; also reads ~/.copilot/mcp-config.json
- **nanoclaw-docs skill** — agent can self-reference docs for troubleshooting
- **`nanoclaw doctor`** — environment health check
- **Azure Bot setup script** (`scripts/setup-teams.sh`) + `/add-teams` skill
- **Container persistence** — `idleTimeout: -1` (default) keeps containers alive indefinitely; no more cold starts between messages
- **Graceful Docker handling** — service starts without Docker (warning only); error messages sent to user via channel instead of silent failure
- **CLI startup feedback** — `nanoclaw start` shows warnings on terminal, not just in logs
- **Skills directory** support from workspace (`~/.nanoclaw/skills/`)

### Changed
- All config reads from `~/.nanoclaw/nanoclaw.json` instead of hardcoded env vars
- Channels (Telegram, Teams) read credentials from config or .env
- Container runner uses workspace paths for mounts
- Store/groups/data directories moved to workspace `state/`

### Technical notes
- GHC SDK internally spawns Copilot CLI as subprocess (headless + stdio)
- Cross-tenant Teams auth requires `channelAuthTenant` set to app's home tenant
- Certificate auth works for inbound JWT but not outbound — use client secret for cross-tenant
- Dev tunnels need `--allow-anonymous` for Bot Framework webhook


## [1.2.0](https://github.com/qwibitai/nanoclaw/compare/v1.1.6...v1.2.0)

[BREAKING] WhatsApp removed from core, now a skill. Run `/add-whatsapp` to re-add (existing auth/groups preserved).
- **fix:** Prevent scheduled tasks from executing twice when container runtime exceeds poll interval (#138, #669)
