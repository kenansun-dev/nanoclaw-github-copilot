# Self-Update

## Status: TODO

## Overview

NanoClaw should be able to update itself — triggered by the user (via chat or CLI) or by the agent receiving a tgz file.

## Current State

`nanoclaw update` already supports:
- `nanoclaw update` — auto: try npm first, fall back to GitHub Release
- `nanoclaw update --package <tgz>` — from local tgz file
- `nanoclaw update --source github` — from GitHub Release
- `nanoclaw update --source npm` — from npm registry

Flow: stop → npm install -g → clear cache → nanoclaw init → start

## What's Missing

### 1. Agent-Triggered Update

User sends a tgz file to the bot (Telegram/Teams) → agent downloads it → runs `nanoclaw update --package <path>`.

Needs:
- MCP tool `nanoclaw-update` or use existing `bash` tool
- File download from channel (already implemented for Teams/Telegram)
- Agent knows to call update after receiving a tgz

### 2. Startup Failure Rollback

If the new version crashes on start, automatically restore the previous version.

Approach:
- Before update: backup current install to `~/.nanoclaw/backup/`
- After update: start with watchdog — if process exits within 30s, restore backup and restart
- systemd: use `RestartSec` + `StartLimitBurst` to detect crash loops
- Windows: schtasks doesn't have equivalent — use a wrapper script

### 3. Post-Update Session Ping

After restart, automatically notify the last active session that the update completed.

Reference: OpenClaw does this with `gateway update.run` — after restart, it pings the last active session with a completion message.

### 4. Hot Reload (Config Only)

Config changes (e.g. `nanoclaw.json` edits) should not require full restart.

Approach:
- Watch `nanoclaw.json` for changes (`fs.watch`)
- Reload config in-place (already have `reloadConfig()`)
- Signal: SIGUSR1 to trigger reload (Linux/macOS)
- Code changes still require full restart

## Implementation Plan

1. **Phase 1**: Add rollback support to `nanoclaw update` — backup before install (npm package + config snapshot), restore on failure
2. **Phase 2**: Add agent-triggered update — MCP tool or agent detects tgz file
3. **Phase 3**: Post-update session notification
4. **Phase 4**: Config hot reload via SIGUSR1/file watch
