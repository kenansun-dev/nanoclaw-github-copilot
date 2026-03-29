---
name: self-knowledge
description: Understand your own configuration, capabilities, and architecture. Use when asked about how you work, what you can do, your settings, or when you need to introspect your own environment.
---

# Self-Knowledge — Know Thyself

Use this skill when the user asks about your setup, capabilities, configuration, or how you work internally.

## Detect your environment

```bash
# Am I on host or in a container?
if [ "$NANOCLAW_HOST_MODE" = "1" ]; then
  echo "MODE: Host (direct)"
else
  echo "MODE: Container (Docker sandbox)"
fi

# What OS/arch?
uname -s -r -m

# What tools do I have?
for cmd in curl git node npm python3 docker sudo chromium; do
  which $cmd 2>/dev/null && echo "✅ $cmd" || echo "❌ $cmd"
done
```

## Read your configuration

**Host mode:**
```bash
cat ~/.nanoclaw/nanoclaw.json
```

**Container mode (main channel):**
```bash
cat /workspace/project/nanoclaw.json 2>/dev/null || echo "Config not mounted (non-main group)"
```

### Key config fields

| Field | What it controls |
|-------|-----------------|
| `agents.defaults.model` | Provider + model (e.g. `github-copilot/claude-sonnet-4`) |
| `agents.defaults.name` | Your name |
| `agents.defaults.mode` | `host` or `sandbox` |
| `channels.telegram.enabled` | Telegram channel on/off |
| `channels.teams.enabled` | Teams channel on/off |
| `sandbox.idleTimeout` | How long container stays alive (0 = forever) |

## Read documentation

Documentation is in the `docs/` directory:

**Host mode:**
```bash
ls ~/path-to-nanoclaw/docs/
```

**Container mode:**
```bash
ls /workspace/docs/ 2>/dev/null || ls /workspace/project/docs/ 2>/dev/null
```

Key docs:
- `getting-started.md` — Setup guide
- `configuration.md` — Config reference
- `troubleshooting.md` — Common issues
- `auth-design.md` — Authentication architecture

## Read your own code (main channel only)

**Host mode:**
```bash
# Your agent runner
cat container/agent-runner-ghc/src/index.ts

# How messages are routed
cat src/index.ts

# How containers are spawned
cat src/container-runner.ts
```

**Container mode:**
```bash
# Project root is read-only mounted
ls /workspace/project/src/
cat /workspace/project/src/index.ts
```

## Know your capabilities

### What you CAN do
- Run bash commands
- Read/write files in your workspace
- Browse the web (agent-browser + curl)
- Use MCP tools (configured in mcp.json)
- Send messages to users (send_message MCP tool)
- Schedule tasks (schedule_task MCP tool)
- Install software (host: permanent, container: sudo apt-get but temporary)

### What you CANNOT do
- Access other groups' workspaces (isolated)
- Modify the nanoclaw source code (read-only in container)
- Change your own configuration (nanoclaw.json is on the host)
- Send messages to unregistered chats
- Access the host filesystem (container mode only)

## Summarize yourself

When asked "what are you?" or "how do you work?", use this template:

> I'm {name}, running on NanoClaw ({mode} mode) with {model}.
> I can {capabilities}. My workspace is at {path}.
> I'm connected via {channels}.
