# Seamless TUI Sessions

## Status: TODO

## Problem

Currently, `nanoclaw tui` always starts a new copilot session. The user loses all conversation context when they exit and re-enter TUI. OpenClaw's TUI continues the main session — `/new` creates a fresh turn but the agent still has access to previous context through memory/compaction.

## Current Behavior

- **Telegram/Teams (service mode)**: Session persists in DB — `sessions` table maps `group_folder` → `session_id`. Agent resumes on every message. ✅
- **TUI interactive (socket mode)**: Connects to service, uses the service's persistent session. ✅ (if service is running)
- **TUI direct (no service)**: `sessionId` starts as `undefined` → new session every time TUI launches. ❌
- **TUI `--ask`**: Always new session. By design — single query, no persistence needed.

## Goal

TUI should feel seamless — exit and re-enter, conversation continues. `/new` resets but previous context is available through memory/compaction.

## OpenClaw's Approach (Reference)

- Main session is persistent — tied to `agent:main` session key
- TUI connects to the main session, not a new one
- `/new` triggers compaction (summary of previous conversation) then starts fresh turn
- MEMORY.md injected into system prompt for cross-session continuity
- Session key is deterministic (derived from agent + channel), not random UUID

## Proposed Changes

### Phase 1: Persist TUI Session ID

1. **TUI direct mode**: Save `sessionId` to `~/.nanoclaw/state/tui-session.json` on exit
2. On next TUI launch: read saved session ID → `resumeSession(id)` → continue conversation
3. `/new` clears the saved session ID → next query creates fresh session
4. `--ask` mode unchanged (always new, no persistence)

### Phase 2: TUI ↔ Service Session Sharing

1. TUI connects to service → uses the same session as Telegram/Teams for that group
2. User can chat via Telegram, then switch to TUI, conversation is the same
3. Session ownership: service holds the session, TUI is a client

### Phase 3: Context Continuity via Memory

1. Memory system (see `features/memory.md`) provides cross-session context
2. Even after `/new`, agent reads MEMORY.md and knows previous context
3. Compaction preserves key decisions/facts before resetting

## Config

```json
"tui": {
  "persistSession": true,
  "sessionGroup": "tui"
}
```

- `persistSession`: save/resume TUI session (default: true)
- `sessionGroup`: which group's session to use (default: "tui" = dedicated TUI session)

## Implementation Notes

- Session file: `~/.nanoclaw/state/tui-session.json` = `{"sessionId": "xxx", "model": "claude-sonnet-4.5", "lastUsed": "2026-04-15T..."}`
- On resume failure (session expired/corrupted): silently create new session, don't error
- TUI socket mode already shares service session — no changes needed for Phase 2
