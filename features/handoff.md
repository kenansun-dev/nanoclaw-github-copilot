# Session Handoff

Transfer active sessions between local Copilot CLI and remote NanoClaw instances.

## Problem

Users work on Copilot CLI locally, then want to continue the conversation remotely via Telegram/Teams through NanoClaw — or vice versa. Currently there's no way to carry over session context.

## Goals

- **CLI → NanoClaw**: Export a local copilot session to a remote NanoClaw instance
- **NanoClaw → CLI**: Pull a remote NanoClaw session back to local CLI
- **Session switching**: Hold the current session, switch to another, switch back

## Session State

Copilot CLI persists sessions in `~/.copilot/session-state/{sessionId}/`:

```
{sessionId}/
├── events.jsonl        # Full conversation history (user messages, assistant turns, tool calls)
├── checkpoints/        # Compaction snapshots
├── workspace.yaml      # Working directory, config
├── files/              # Session-created files
└── research/           # Research results
```

NanoClaw stores sessions in `~/.nanoclaw/data/sessions/{group}/.copilot/session-state/{sessionId}/` — same format.

SDK supports `resumeSession(sessionId)` to restore a session from its state directory.

## Context to Restore

When handing off or switching back, these need to be preserved/restored:

1. **Conversation history** — `events.jsonl` (SDK handles via `resumeSession`)
2. **Working directory** — cwd associated with the session
3. **MCP servers** — which servers are loaded
4. **Skills** — loaded skill directories
5. **Config** — thinkLevel, model, per-session settings

## User Experience

### Session List

```
nanoclaw session list
```

Shows recent sessions with semantic summary + time, not raw UUIDs:

```
Recent sessions:
  1. [main] "讨论 Teams manifest 和 web_search" — 2h ago, 45 messages
  2. [main] "MCP Azure auth 配置" — yesterday, 12 messages
  3. [daily] "每日新闻播报" — 3 days ago, 8 messages
```

Summaries extracted from last few messages in `events.jsonl`.

### Export / Import

```bash
# Export session from NanoClaw to local
nanoclaw session export 1 --output ./session-backup/

# Import local copilot session into NanoClaw
nanoclaw session import --path ~/.copilot/session-state/{id}/ --group main
```

### Session Hold + Switch

```
/handoff import 2    → Switch to session 2, hold current session
/handoff back        → Switch back to held session
```

Implementation: session stack per group in DB.

```
active_session_id: current session
session_stack: ["prev-session-id", "prev-prev-session-id"]
```

`/handoff import` pushes current to stack, sets new active.
`/handoff back` pops stack, restores previous.

## Challenges

1. **Working directory mismatch** — Local `/Users/kenan/project` vs remote `/home/pi/.nanoclaw/groups/main`. File path references in session will break.
2. **MCP server differences** — Local has different MCP servers than remote.
3. **Token/credential differences** — Local and remote may have different GitHub tokens.
4. **CLI version compatibility** — Session state format depends on CLI version.
5. **Large session state** — `events.jsonl` can be very large for long sessions.

## Implementation Plan

### Phase 1: Session List + Hold/Switch (local only)
- `nanoclaw session list` — list sessions with summary
- `/handoff` slash command — switch between sessions on same NanoClaw
- Session stack in DB

### Phase 2: Export/Import
- `nanoclaw session export` — package session state as zip
- `nanoclaw session import` — unpack into NanoClaw session dir
- Only sync `events.jsonl` + `checkpoints/` (not files)

### Phase 3: Cross-machine Sync
- Auto-sync via shared storage or SSH
- Path remapping for working directory
- MCP server config reconciliation

## Open Questions

- Should handoff preserve tool results (bash output, file contents)?
- How to handle session compaction state across handoff?
- Should the agent be aware of the handoff (system message)?
