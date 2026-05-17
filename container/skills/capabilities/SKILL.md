---
name: capabilities
description: Show what this NanoClaw instance can do — installed skills, available tools, and system info. Use when the user asks what the bot can do or runs /capabilities.
---

# /capabilities — System Capabilities Report

Generate a report of what this NanoClaw instance can do.

## 1. Detect environment

```bash
# Host or container?
if [ "$NANOCLAW_HOST_MODE" = "1" ]; then
  echo "Mode: Host"
else
  echo "Mode: Container"
fi

# Provider
if [ -n "$COPILOT_MODEL" ] || [ -d "$HOME/.copilot" ]; then
  echo "Provider: GitHub Copilot (GHC)"
elif command -v claude &>/dev/null; then
  echo "Provider: Claude Code (CC)"
else
  echo "Provider: unknown"
fi

echo "Model: ${COPILOT_MODEL:-default}"
echo "OS: $(uname -s 2>/dev/null || echo Windows) $(uname -r 2>/dev/null || ver 2>nul)"
echo "Arch: $(uname -m 2>/dev/null || echo unknown)"
echo "Shell: $SHELL ($(basename "$SHELL" 2>/dev/null || echo unknown))"
echo "Node: $(node --version 2>/dev/null || echo 'N/A')"
echo "User: $(whoami 2>/dev/null || echo unknown)"
echo "Working dir: $(pwd)"
```

On Windows (PowerShell), use:

```powershell
echo "OS: Windows $([System.Environment]::OSVersion.Version)"
echo "Shell: PowerShell $($PSVersionTable.PSVersion)"
echo "Node: $(node --version)"
echo "User: $env:USERNAME"
```

## 2. Installed skills

```bash
# Host mode: check workspace and package skills
SKILLS_FOUND=0
for DIR in \
  "${NANOCLAW_SKILLS_DIR:-}" \
  "$HOME/.nanoclaw/skills" \
  "$(npm root -g 2>/dev/null)/nanoclaw-github-copilot/container/skills" \
  "/workspace/skills" \
  ; do
  if [ -d "$DIR" ] && [ "$(ls -A "$DIR" 2>/dev/null)" ]; then
    echo "Skills directory: $DIR"
    ls -1 "$DIR" 2>/dev/null
    SKILLS_FOUND=1
  fi
done
[ "$SKILLS_FOUND" = "0" ] && echo "No skills found"
```

## 3. Available tools

You always have access to:

- **Core**: Bash, Read, Write, Edit, Glob, Grep
- **Web** (if GitHub MCP enabled): WebSearch, WebFetch
- **NanoClaw MCP**: send_message, send_file, schedule_task, list_tasks, react, register_group, pdf-read_pdf
- **GitHub MCP** (if enabled): issues, PRs, code search, repos, actions

## 4. Slash commands

Source of truth: `src/slash-commands.ts` (`COMMANDS` array). Run `/help` in chat
for the live auto-generated list. Current snapshot:

| Command                                  | Description                            |
| ---------------------------------------- | -------------------------------------- |
| `/think [off\|low\|medium\|high\|xhigh]` | Set reasoning effort                   |
| `/reasoning [on\|off\|flash]`            | Show/hide/flash thinking               |
| `/new` (alias `/reset`)                  | Reset session                          |
| `/status`                                | Health check, auth, models (file-only) |
| `/capabilities`                          | This report                            |
| `/tasks`                                 | List scheduled tasks                   |
| `/wiki [topic]`                          | Knowledge base                         |
| `/model [id] [--default]`                | Show/set active model                  |
| `/models`                                | List provider model catalog            |
| `/mcp`                                   | List configured MCP servers            |
| `/plugin [...]`                          | Manage plugins                         |
| `/help`                                  | All commands (auto-generated)          |

## 5. Output format

Compile the above into a clean report for the user. Keep it concise.
