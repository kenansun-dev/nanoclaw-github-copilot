---
name: status
description: Quick read-only health check — session context, workspace mounts, tool availability, and task snapshot. Use when the user asks for system status or runs /status.
---

# /status — System Status Check

Generate a quick read-only status report of the current agent environment.

This command works in **all chats** (main and non-main). Adapt the report based on what's available.

## How to gather the information

Run the checks below and compile results into the report format.

### 1. Session context and provider detection

```bash
echo "Timestamp: $(date)"
echo "Working dir: $(pwd)"

# Detect provider: GHC (GitHub Copilot) vs CC (Claude Code)
if command -v github-copilot-cli &>/dev/null || [ -d "$HOME/.copilot" ] || [ -n "$COPILOT_HOME" ]; then
  echo "Provider: GitHub Copilot (GHC)"
  github-copilot-cli --version 2>/dev/null || echo "GHC CLI: bundled"
elif command -v claude &>/dev/null; then
  echo "Provider: Claude Code (CC)"
  claude --version 2>/dev/null
else
  echo "Provider: unknown"
fi

# Detect model from environment or config
if [ -n "$COPILOT_HOME" ] && [ -f "$COPILOT_HOME/config.json" ]; then
  echo "Config: $COPILOT_HOME/config.json"
  cat "$COPILOT_HOME/config.json" 2>/dev/null | head -5
fi
```

### 2. Workspace and mount visibility

```bash
echo "=== Workspace ==="
ls /workspace/ 2>/dev/null
echo "=== Group folder ==="
ls /workspace/group/ 2>/dev/null | head -20
echo "=== Extra mounts ==="
ls /workspace/extra/ 2>/dev/null || echo "none"
echo "=== IPC ==="
ls /workspace/ipc/ 2>/dev/null
```

### 3. Tool availability

Confirm which tool families are available to you:

- **Core:** Bash, Read, Write, Edit, Glob, Grep
- **Web:** WebSearch, WebFetch
- **Orchestration:** Task, TaskOutput, TaskStop, TeamCreate, TeamDelete, SendMessage
- **MCP:** mcp__nanoclaw__* (send_message, schedule_task, list_tasks, etc.)

### 4. Runtime info

```bash
node --version 2>/dev/null
which agent-browser 2>/dev/null && echo "agent-browser: available" || echo "agent-browser: not installed"
```

### 5. Task snapshot

Use the MCP tool to list tasks:

```
Call mcp__nanoclaw__list_tasks to get scheduled tasks.
```

If no tasks exist, report "No scheduled tasks." **Do not invent or hallucinate tasks.** Only report what the tool actually returns.

## Report format

Present as a clean, readable message:

```
🔍 *NanoClaw Status*

*Session:*
• Provider: GitHub Copilot / Claude Code
• Model: (from config or system prompt)
• Mode: Host / Sandbox (Container)
• Time: 2026-04-05 00:45 CST
• Working dir: /workspace/group

*Workspace:*
• Group folder: ✓ (N files)
• Extra mounts: none / N directories
• IPC: ✓ (messages, tasks, input)

*Tools:*
• Core: ✓  Web: ✓  Orchestration: ✓  MCP: ✓

*Runtime:*
• Node: vXX.X.X
• agent-browser: ✓ / not installed

*Scheduled Tasks:*
• N active tasks / No scheduled tasks
```

**Important:** Report ONLY what you actually find. Do not guess or make up information. If you can't detect the model, say "unknown". If no tasks exist, say "No scheduled tasks."

**See also:** `/capabilities` for a full list of installed skills and tools.
