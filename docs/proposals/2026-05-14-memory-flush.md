# Proposal: Memory flush (replace daily-summary cron with OpenClaw-style flush)

> **Status**: draft, awaiting kenan ✅ before implementation.
> **Author**: Kenan Rpi5 Claw, 2026-05-14.
> **Refs**: replaces `src/memory/cron.ts` + `ensureDailySummaryTask` machinery.
> **Upstream reference**: OpenClaw `extensions/memory-core/src/flush-plan.ts`,
> `src/auto-reply/reply/memory-flush.ts`, `src/agents/pi-tools.read.ts`
> (`wrapToolMemoryFlushAppendOnlyWrite`).

## 1. Problem

### 1.1 What we have today

`src/memory/cron.ts` registers one `memory-daily-summary:<chatJid>` cron
task **per chat that ever runs an agent**. Each task fires at 23:45 local
time, in an isolated session (post PR #46 / detached-tasks §4.1.A), with
a hardcoded prompt asking the agent to "summarize today's chat history
and append highlights via the `memory_append_today` MCP tool".

Registered call site: `src/host-runner.ts:204`
(`ensureDailySummaryTask({ chatJid, groupFolder })` is invoked every time
`runHostAgent` runs, lazy-idempotent).

DB rows audited on rpi5 today (2026-05-14):

| id | chat | status | last_run |
|---|---|---|---|
| `memory-daily-summary:tg:8731187021` | active TG DM | active | 2026-05-13 23:46Z |
| `memory-daily-summary:tui:default` | dead TUI | paused | 2026-04-26 (orphan-auto-pause) |

### 1.2 Why this is wrong, in order of severity

1. **Calendar-driven, not conversation-driven**. The 23:45 boundary cuts
   a single ongoing topic in two if it spans midnight. Topics that wrap
   up at 14:00 sit in a partial file until the cron fires 9 hours later.
2. **Single-sided source data**. The cron task reads `messages` table,
   which currently only stores **inbound** (`is_from_me=0`) — verified
   today: 874/874 rows are inbound, 0 outbound. So the daily summary can
   write *what the user asked* but not *what the agent decided / did*.
3. **Per-chat cron sprawl**. Each chat that ever pings the agent gets its
   own cron row. Long-tail noise: orphan-paused rows accumulate (TUI
   example above sat paused for 18 days).
4. **Burns tokens on quiet days**. The cron has no idea whether anything
   noteworthy happened. It fires every 23:45 regardless and asks the
   model to produce 3–7 bullets even when the day produced none.
5. **Diverges from OpenClaw**. We claimed to mirror OpenClaw's
   memory journal. OpenClaw doesn't do this. OpenClaw triggers a flush
   on **context-pressure**, not on a wall-clock cron (see §2).

### 1.3 What we are not solving here

- `MEMORY.md` curation (the curated long-term file). That's an agent /
  user concern, not a runtime trigger concern.
- `memory_append_today` MCP tool — keep it. Agent-initiated journal
  entries during normal conversation are useful and orthogonal.
- Backup / rotation of memory files. Out of scope; current files are
  small (KBs).

## 2. How OpenClaw actually does it

Read in `~/gitrepos/openclaw` on 2026-05-14, HEAD `bd3ad3436`. Three
relevant pieces:

### 2.1 The trigger (`src/auto-reply/reply/memory-flush.ts`)

```ts
export function shouldRunMemoryFlush(params: {
  entry?: SessionEntry;          // running session: token counts + flush history
  tokenCount?: number;           // fresh override
  contextWindowTokens: number;   // model's context window
  reserveTokensFloor: number;    // safety margin
  softThresholdTokens: number;   // configurable, default 4000
}): boolean
```

- Threshold = `contextWindow - reserveTokensFloor - softThresholdTokens`.
- Fires when current usage ≥ threshold **and** no flush has been
  performed for the current compaction cycle.
- `computeContextHash(messages)` is used as a state-based dedup: if
  the last 3 user/assistant messages haven't changed, don't re-flush.

### 2.2 The plan (`extensions/memory-core/src/flush-plan.ts`)

`buildMemoryFlushPlan({cfg, nowMs}) → MemoryFlushPlan | null` returns:

- `relativePath`: `memory/${dateStamp}.md` (timezone-aware; one file per
  calendar date)
- `prompt`: "Pre-compaction memory flush. Store durable memories only in
  `memory/${dateStamp}.md`. APPEND only. Don't touch MEMORY.md / SOUL.md
  etc. If nothing to store, reply `NO_REPLY`."
- `systemPrompt`: stricter variant of the above
- Hard-disable knob: `cfg.agents.defaults.compaction.memoryFlush.enabled`

### 2.3 The write lock (`src/agents/pi-tools.read.ts:485`)

`wrapToolMemoryFlushAppendOnlyWrite(tool, options)` wraps the agent's
`write` tool for the *flush turn only*:

- Resolves the agent's requested path against the workspace root.
- If it doesn't match the planned `memory/${dateStamp}.md` → throw.
- Even if it matches → switch to **append**, not overwrite.

So during the flush turn the agent literally cannot write anywhere
else, and cannot trash existing content. The trigger is "your context
is full, capture what's durable, NO_REPLY otherwise".

### 2.4 The dispatch (`src/auto-reply/reply/agent-runner-memory.ts:514`)

`runMemoryFlushIfNeeded({...})` runs **one extra agent turn** with
`trigger: 'memory'`. Same provider, same model, same MCP tools —
just a different system prompt and a write-tool wrapper. The agent
decides what to keep. Then normal auto-compaction proceeds.

### Key insight

OpenClaw's memory journal is **agent-curated, capacity-triggered,
append-only to a single dated file**. It's not "summarize today" — it's
"about to lose context, save what mattered". The model's role is
*editorial*: pick durable bits, skip noise, write nothing if
appropriate.

## 3. Design for NanoClaw

### 3.1 Scope

This proposal:

- **Deletes** `src/memory/cron.ts` + `ensureDailySummaryTask` and its
  call site in `host-runner.ts:202-210`.
- **Deletes** the two `memory-daily-summary:*` rows from
  `scheduled_tasks` on first boot after deploy (idempotent migration).
- **Adds** `src/memory/flush/` with:
  - `plan.ts` (port of OpenClaw's `buildMemoryFlushPlan`)
  - `transcript-reader.ts` (provider dispatcher — see §3.4)
  - `runner.ts` (the flush turn wrapper)
  - `write-guard.ts` (the append-only path-lock)
- **Hooks** the flush check into both the **per-turn auto-reply path**
  (capacity trigger) and **`/new` / `/reset` slash command path**
  (manual trigger; replaces today's "just delete session" behaviour).
- **Keeps** `memory_append_today` MCP tool unchanged.

### 3.2 Triggers (any one fires)

| Trigger | Source | Notes |
|---|---|---|
| **Capacity** | Per-turn `shouldRunFlush(entry, tokenCount, cfg)` | Same arithmetic as OpenClaw. Token estimate comes from GHC events / CC transcript size. |
| **Transcript byte size** | Same per-turn check | Fallback when token estimate is missing or stale. Default: 2 MiB, configurable. |
| **`/new` or `/reset`** | `src/slash-commands.ts:179-194` | Flush *before* deleting `sessions` row + `.copilot` / `.claude` dirs. |
| **Idle decay** *(optional, phase 2)* | A single sweep cron, runs hourly, scans active chats whose `messages` table shows `MAX(timestamp) < now - 72h` and triggers a flush turn against the stale transcript before evicting the session. | Phase 2; not in the first PR. |

Not a trigger: wall-clock 23:45. Removed entirely.

### 3.3 File layout

OpenClaw uses a single global `memory/${YYYY-MM-DD}.md` for the whole
agent. We have multiple chats sharing one workspace. Two options:

**Option A** (recommended): `memory/${YYYY-MM-DD}.md`, single file per
day across all chats. Pro: matches OpenClaw 1:1. Con: chat A's content
visible to chat B agents on startup.

**Option B**: `memory/<safe-chat-slug>/${YYYY-MM-DD}.md`, one file per
chat per day. Pro: privacy / isolation. Con: more files; agent's
"recall everything I've ever said" gets noisier; diverges from upstream.

**Recommendation: A**. Reasons:

1. NanoClaw users today typically run a single owner with a small
   number of chats; cross-chat leakage is not a real concern.
2. The OpenClaw startup-context loader (`buildSessionStartupContext`
   reads `memory/${stamp}.md` for the last N days) just works.
3. We can revisit if a multi-tenant deployment ever lands; an
   `${YYYY-MM-DD}.md → ${YYYY-MM-DD}/<chat>.md` migration is a one-time
   move.

### 3.4 Provider abstraction (GHC vs CC)

`transcript-reader.ts` exposes one interface; two implementations.

```ts
export interface TranscriptReader {
  /** Estimate live context-token usage for the active session. */
  estimateTokens(args: {
    sessionId: string;
    groupFolder: string;
  }): Promise<number | null>;

  /** Size of the on-disk transcript file, for the byte-size trigger. */
  transcriptByteSize(args: {
    sessionId: string;
    groupFolder: string;
  }): Promise<number>;

  /** Read latest N user/assistant messages for prompt context. */
  readMessages(args: {
    sessionId: string;
    groupFolder: string;
    limit?: number;
  }): Promise<Array<{ role: 'user' | 'assistant'; text: string; ts: Date }>>;
}

export function getReader(provider: 'github-copilot' | 'anthropic'): TranscriptReader;
```

**GHC reader** (`readers/ghc.ts`):

- File path: `<groupDir>/.copilot/session-state/<sid>/events.jsonl`.
- `transcriptByteSize` = `fs.statSync(...).size`.
- `readMessages` = iterate JSONL lines, keep `entry.type === 'message'`
  with `role` in `{user, assistant}`, extract `text` block (see
  OpenClaw `transcript.ts` for the exact text extraction shape — we can
  port it directly).
- `estimateTokens` = sum of `.tokenUsage` events if GHC emits them,
  else `null` (the byte-size trigger covers).

**CC reader** (`readers/cc.ts`):

- File path: `<groupDir>/.claude/projects/<encoded>/<sid>.jsonl`.
- Same shape, different message schema (CC has its own envelope —
  port from `providers/claude.ts` parsing if needed).

**Dispatcher** (`getReader`): single switch on provider. No factory
ceremony; the test seams are the two reader files themselves.

This abstraction is also useful for **other future memory features**
(per-chat search, transcript export, etc.) — not just flush.

### 3.5 The flush turn

```ts
// src/memory/flush/runner.ts
export async function runFlushIfNeeded(ctx: {
  groupFolder: string;
  chatJid: string;
  provider: 'github-copilot' | 'anthropic';
  sessionId: string;
  channel: Channel;        // for the eventual NO_REPLY suppression
  cfg: ResolvedConfig;
  reason: 'capacity' | 'transcript-bytes' | 'slash-reset';
}): Promise<{ ran: boolean; wrote: boolean; path?: string }>;
```

Internal flow:

1. Compute `plan = buildFlushPlan({cfg, nowMs})` →
   `{ relativePath: 'memory/2026-05-14.md', prompt, systemPrompt }`.
2. If `reason === 'capacity'`, double-check `shouldRunFlush(...)` is
   still true (debounce).
3. If `reason === 'slash-reset'`, always proceed.
4. Build a one-shot agent invocation that:
   - reuses the same provider + sessionId (so the agent has full
     context),
   - injects `plan.systemPrompt` as an additional system message,
   - sends `plan.prompt` as the user message,
   - wraps the `write` tool via `writeGuard(plan.relativePath)` so the
     agent **can only append** to the planned daily file.
5. If reply == `NO_REPLY` (or starts with the silent-reply token),
   record dedup hash + return `{ ran: true, wrote: false }`.
6. Else assume the agent already wrote (its write tool is hooked) and
   return `{ ran: true, wrote: true, path }`.
7. For `slash-reset`: after step 5/6, proceed with the original
   `deleteSession` + `rmSync('.copilot')`.

### 3.6 The write guard

```ts
// src/memory/flush/write-guard.ts
export function wrapWriteToolForFlush(
  writeTool: MCPTool,
  opts: { workspaceRoot: string; relativePath: string }
): MCPTool;
```

- Resolves agent-requested path against `workspaceRoot`.
- Compares to `path.resolve(workspaceRoot, opts.relativePath)`. Mismatch
  → throw with a clear "memory flush writes are restricted to X" error.
- Implements append: read existing file, append separator, write. (Or
  use `fs.appendFile`. Match OpenClaw's "prepend newline if file ends
  without one" detail.)
- Sandbox-aware (`appendFileWithinRoot` equivalent) if/when NanoClaw
  gets a workspace sandbox; today host has direct fs access.

### 3.7 Configuration

```jsonc
// nanoclaw.json
{
  "memory": {
    "flush": {
      "enabled": true,                          // master switch
      "softThresholdTokens": 4000,              // OpenClaw default
      "forceFlushTranscriptBytes": 2097152,     // 2 MiB
      "prompt": null,                           // null = use built-in
      "systemPrompt": null,                     // null = use built-in
      "filePathTemplate": "memory/{date}.md"    // future: per-chat overrides
    }
  }
}
```

- `enabled: false` disables capacity + byte-size triggers but **keeps**
  the `/reset` flush (manual user intent always honoured).
- Removing the cron means no more `memory.dailySummary.*` knobs in
  config. Deprecation note in `CHANGELOG.md`.

### 3.8 Migration & cleanup on first boot

Boot-time, idempotent, in a new `src/memory/migrate-from-cron.ts`:

```sql
DELETE FROM scheduled_tasks
  WHERE id LIKE 'memory-daily-summary:%';
```

Log a single info line listing the deleted ids (so users see why their
list of tasks shrank). No-op on second boot.

## 4. Implementation plan

### Phase 1 (one PR, target: ~600 LOC excluding tests)

| File | Action | Approx LOC |
|---|---|---|
| `src/memory/flush/plan.ts` | new (port `buildMemoryFlushPlan`) | 120 |
| `src/memory/flush/runner.ts` | new | 180 |
| `src/memory/flush/write-guard.ts` | new | 80 |
| `src/memory/flush/transcript-reader.ts` | new (dispatcher) | 40 |
| `src/memory/flush/readers/ghc.ts` | new | 120 |
| `src/memory/flush/readers/cc.ts` | new | 120 |
| `src/memory/flush/migrate-from-cron.ts` | new (one-shot DELETE) | 30 |
| `src/host-runner.ts` | wire capacity check into per-turn path | -8 / +12 |
| `src/slash-commands.ts` | call `runFlushIfNeeded({reason:'slash-reset'})` before delete | +10 |
| `src/memory/cron.ts` | **DELETE** | -360 |
| `src/memory/cron.test.ts` | **DELETE** | -? |
| Tests for new files | new | ~600 |

Net change: roughly +400 source LOC, -360 dead LOC. Tests +600.

### Phase 2 (separate PR, optional)

- Idle-decay trigger (the hourly sweep mentioned in §3.2).
- Per-chat directory layout (Option B in §3.3) iff multi-tenant ever
  becomes a need.

### Test coverage (Phase 1)

1. **plan.ts**: timezone behaviour, prompt-injection of date stamp,
   `enabled:false` returns `null`.
2. **write-guard.ts**: blocks writes to other paths; appends correctly;
   creates parent dir; handles missing-trailing-newline.
3. **runner.ts (mocked agent invoker)**: `NO_REPLY` path doesn't claim
   wrote; non-empty reply path resolves to the planned path.
4. **transcript-reader / readers**: parse a fixture `events.jsonl`
   (GHC) and `<sid>.jsonl` (CC) into the same message shape.
5. **slash-reset integration**: existing `/new` test extended to
   assert flush ran *before* session deletion.
6. **migrate-from-cron**: rows deleted; second invocation is a no-op.

E2e (rpi5, after `nanoclaw update --package`):

- `nanoclaw task ls` → no `memory-daily-summary:*` entries.
- Drive a Telegram chat to ~80% of context window (or send `/reset`),
  observe `memory/2026-05-14.md` getting an append.

### Risk register

| Risk | Mitigation |
|---|---|
| Token estimate unavailable from GHC → capacity trigger silent | Byte-size trigger fires instead; default 2 MiB is generous. |
| Agent ignores `NO_REPLY` and writes a stub on a quiet day | Write guard is append-only; worst case = noise in daily file. Could add a "min content length" check before persisting, deferred. |
| `/reset` flush takes long → user sees `/reset` ack only after flush returns | Run flush detached; ack `/reset` immediately, flush in background. Same group-queue slot as the task slot so it doesn't block the chat. |
| Concurrent capacity + slash-reset flushes for same session | Mutex per `sessionId`. Use existing `slotKey` infrastructure from PR #44 if it covers this; otherwise add a tiny `WeakMap<sessionId, Promise>` guard in `runner.ts`. |
| OpenClaw changes its flush plan shape (we're not on the plugin API) | We're porting **values**, not the plugin protocol. If upstream evolves we re-port. No dynamic link. |

### Open questions for kenan ✅

1. **File layout: A or B?** (§3.3 — default recommendation A.)
2. **Phase 1 only, or include idle-decay?** (Recommendation: Phase 1
   only; idle-decay later if data says we need it.)
3. **Hard-delete the migration legacy rows, or pause them?**
   (Recommendation: hard-delete; they're a closed concept.)
4. **Keep `memory_append_today` MCP tool?** (Recommendation: yes; it's
   the agent-initiated path, orthogonal to the auto-flush path.)
5. **Honour `enabled:false` for `/reset` path?** (Recommendation: no —
   manual user intent always flushes. As written in §3.7.)

## 5. Out of scope

- Compaction itself (handled by SDK / provider, not us).
- MEMORY.md curation cadence (agent + user decide).
- Cross-chat memory shared search / index (separate proposal if ever).
- Encrypting memory files at rest.
- Provider-extension API (we're not building a NanoClaw plugin
  system in this PR).

## 6. Why this is the right answer (TL;DR)

We borrowed the **name** "daily memory" from OpenClaw but built a
**different mechanism** (per-chat 23:45 cron with single-sided data).
This proposal aligns mechanism with name:

- Same trigger model as OpenClaw (capacity + manual, not cron).
- Same file shape (`memory/${date}.md`, append-only).
- Same agent-curatorial-role pattern (NO_REPLY on quiet days).
- Cleaner code: one runtime path, one set of triggers, one delete of
  300+ stale LOC.
- Provider-portable for the GHC/CC abstraction the rest of the
  codebase already wants.
