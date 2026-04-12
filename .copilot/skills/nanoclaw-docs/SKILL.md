---
name: nanoclaw-docs
description: >
  Search and read NanoClaw documentation to help users with setup,
  configuration, troubleshooting, and usage questions. Use when the user
  asks about how NanoClaw works, how to configure channels, fix errors, etc.
metadata:
  openclaw:
    emoji: "📚"
---

# NanoClaw Docs

Search and read NanoClaw documentation to answer user questions.

## When to use

Use this skill when the user asks about:
- How to set up or configure NanoClaw
- How channels work (Telegram, Teams)
- Authentication / provider setup
- Troubleshooting errors
- Architecture / how things work internally
- CLI commands

## How to use

Documentation is available at `/workspace/docs/` inside the container.
Read the relevant file based on the user's question:

### File mapping

| Question about | Read this file |
|---|---|
| Getting started / setup | `docs/getting-started.md` |
| nanoclaw.json config | `docs/configuration.md` |
| Errors / not working | `docs/troubleshooting.md` |
| Teams setup / Azure Bot | `docs/channels/teams.md` or `docs/troubleshooting.md` |
| Telegram setup | `docs/channels/telegram.md` or `docs/getting-started.md` |
| Architecture | `docs/architecture.md` or `docs/SPEC.md` |
| CLI commands | `docs/cli.md` |
| MCP servers | `docs/mcp.md` |
| Skills | `docs/skills.md` |
| Auth / providers | `docs/providers.md` or `docs/auth-design.md` |

### Steps

1. Identify what the user is asking about
2. Read the relevant doc file(s) using the `read_file` tool
3. Answer based on the documentation
4. If the doc doesn't cover it, say so and suggest where to look

### Example

User: "Teams bot not responding"

1. Read `docs/troubleshooting.md`
2. Find the "Teams specific" section
3. Walk through the checklist with the user
4. If needed, suggest running `nanoclaw doctor`
