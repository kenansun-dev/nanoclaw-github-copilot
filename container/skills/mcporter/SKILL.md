---
name: mcporter
description: Manage MCP (Model Context Protocol) servers. Use when the user asks to connect to a remote MCP server, add an MCP tool, authenticate with an MCP service, or troubleshoot MCP connections.
---

# MCP Server Management (mcporter)

You can help users manage their MCP server connections using the `mcporter` CLI.

## Common tasks

### List configured MCP servers
```bash
mcporter list --config /workspace/mcporter/mcporter.json
```

### Add a new remote MCP server
```bash
mcporter config add <name> <url> --config /workspace/mcporter/mcporter.json
```
Example:
```bash
mcporter config add devbox https://devbox.microsoft.com/mcp --config /workspace/mcporter/mcporter.json
```

### Authenticate a server (OAuth/PRM)
```bash
mcporter auth <name> --config /workspace/mcporter/mcporter.json
```
This will:
1. Discover the server's OAuth requirements via PRM (RFC 9728)
2. Start a device code or browser-based login flow
3. Display the login URL and code to the user
4. Cache the token for future use

**Important:** When auth requires user interaction (login URL + code), send the information to the user immediately via `mcp__nanoclaw__send_message` so they can complete login in their browser.

### Check server status
```bash
mcporter list <name> --schema --config /workspace/mcporter/mcporter.json
```

### Start/stop the connection daemon
```bash
mcporter daemon start --config /workspace/mcporter/mcporter.json
mcporter daemon status --config /workspace/mcporter/mcporter.json
```

## Notes
- mcporter config is at `/workspace/mcporter/mcporter.json` (mounted from `~/.nanoclaw/mcporter/`)
- If mcporter is not installed in the container, tell the user to run `nanoclaw mcp` commands from the host instead
- Remote MCP servers that require OAuth must be authenticated before they can be used
- After adding/authenticating a server, the user may need to restart nanoclaw for changes to take effect
