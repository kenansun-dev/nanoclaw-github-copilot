# Progress drafts: in-chat tool-call status

**Status**: proposal, awaiting owner ack.
**Owner ask** (Discord #nanoclaw 2026-05-23 23:20, kenan): "OpenClaw 有个功能，
可以在聊天里面打印目前正在进行的 tool call 或者工作总结。这和 `<think>`
渲染分开，且可以配置。调研一下它怎么做的，然后设计、分工在 nanoclaw 上实现。
优先 GHC，CC 如果不方便后做。主要是 SDK 有没有把 toolcall 信息传回来。"

## TL;DR

1. **OpenClaw "progress draft"** is a single chat message that the host edits
   while a turn runs, with compact tool-progress lines like `🛠️ Bash: run tests`.
   Independent of thinking — `<think>` keeps its own bubble.
2. **GHC SDK does emit tool events** via `SessionConfig.onEvent`: ✅
   `tool.execution_start`, `tool.execution_progress`, `tool.execution_complete`,
   plus richer items like `assistant.intent`, `plan.changed`, `permission.requested`,
   `subagent.started/completed`. Each carries `toolName`, `arguments`,
   `mcpServerName`, `progressMessage`, `success`. (Source: container-runner-ghc
   `node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts:2067-2245`.)
3. **CC SDK** has `PreToolUse` / `PostToolUse` hooks + `tool_use` / `tool_result`
   content blocks in streamed `SDKMessage` envelopes. Same shape achievable via
   different surface. ✅
4. **Fork side** has zero progress-draft infra today (`grep -rn "progressDraft\|toolProgress" src/ container/` → 0 hits). Telegram already has `editMessage`; Teams has
   native streaming — both are usable transports.
5. **Single PR today**: `chore/2026-05-23-progress-drafts`. GHC first, CC behind
   a runner-agnostic event shape so we can light it up later without rework.

## Background: how OpenClaw does it

(Source: `~/.npm-global/lib/node_modules/openclaw/docs/concepts/progress-drafts.md`
+ `dist/channel-streaming-DeWT18LP.d.ts`.)

Per-channel knob: `channels.<channel>.streaming.mode` ∈
`off | partial | block | progress`. In `progress` mode:

- Host opens **one draft message** after a delay (default 5000 ms) or after the
  second "work event" — whichever comes first. Skips draft entirely for plain
  text-only replies.
- A `label` line (`Thinking...`, `Shelling...`, custom pool, or static) sits at
  top, then a rolling list of progress lines (`maxLines`, default ~5).
- Each line is built by `buildChannelProgressDraftLine()` from a typed event:
  ```ts
  type ChannelProgressDraftLineInput =
    | { event: "tool"; name?; phase?; args? }
    | { event: "item"; itemKind?; title?; status?; progressText?; ... }
    | { event: "plan"; phase?; steps? }
    | { event: "approval"; phase?; command?; reason? }
    | { event: "command-output"; phase?; status?; exitCode? }
    | { event: "patch"; added?; modified?; deleted?; summary? }
  ```
- Detail mode: `agents.defaults.toolProgressDetail` ∈ `explain | raw`.
  `explain` = `🛠️ check JS syntax for /tmp/app.js`; `raw` appends
  `, node --check /tmp/app.js`.
- On final answer: edit the draft into the answer if it fits one safe preview
  message, else send normal final and either leave draft visible (`maxLines`
  trimmed) or replace per channel rules.
- Independent of `<think>` rendering — that has its own path
  (`reasoning_delta` → thinking bubble; we just shipped phase B for Teams).
- Suppresses legacy standalone tool-progress messages while a draft is active
  (`resolveChannelStreamingSuppressDefaultToolProgressMessages`).

## SDK readout — do tool calls actually come back?

### GHC SDK (`@github/copilot-sdk@0.3.0`) — yes ✅

All three events present (verified in
`container/agent-runner-ghc/node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts`):

| Event type | Key fields | Notes |
|---|---|---|
| `tool.execution_start` | `toolName`, `arguments`, `toolCallId`, optional `mcpServerName`, `mcpToolName` | Fires when the agent starts invoking a tool. |
| `tool.execution_progress` | `progressMessage`, `toolCallId`, `ephemeral: true` | Mid-execution status (e.g., MCP server reports "fetched 12/40 results"). |
| `tool.execution_complete` | `toolCallId`, `success`, `error?`, `result?`, `model?`, `interactionId?` | Done. `success` distinguishes ok vs failed. |

Plus richer signals for the same draft (already in the union):

- `assistant.intent` — "I'm going to do X" preamble
- `plan.changed` — when the agent posts a plan
- `permission.requested` / `permission.completed` — approval gates
- `subagent.started` / `subagent.completed` — sub-agent fan-out
- `command.execute` / `command.completed` — shell command lifecycle

Our runner already registers `onEvent` (see
`container/agent-runner-ghc/src/index.ts:399-417`) but only handles MCP-oauth
and warning/error variants. Tool events flow through and are dropped.

### CC SDK (`@anthropic-ai/claude-agent-sdk@0.2.116`) — yes, different surface ✅

- `HOOK_EVENTS` includes `PreToolUse` / `PostToolUse` / `PostToolUseFailure` /
  `PostToolBatch` (see `sdk.d.ts:721`). Hook input carries `tool_use_id`,
  `tool_name`, `tool_input`.
- Streamed messages include `tool_use` and `tool_result` content blocks per
  Anthropic message protocol.
- Subagent lifecycle: `SubagentStart` / `SubagentStop`.
- No native "progress" callback — but `PreToolUse`/`PostToolUse` covers the
  start/complete pair; mid-execution progress is rare on CC and can be
  collapsed.

**Conclusion for the brief**: SDK emits the data we need on both runtimes. GHC
gets first-class progress; CC ships behind the same event-shape with `start`/
`complete` only at first cut.

## Design

### Layers

```
┌──────────────────────────────────────────────────────────────────┐
│ HOST (src/)                                                      │
│  ┌─ ProgressDraftSession (per-chat, per-turn) ──────────────┐    │
│  │  • opens after delay or 2nd work event                   │    │
│  │  • holds label + rolling lines                           │    │
│  │  • channel-agnostic; calls channel.editMessage()         │    │
│  │  • finalize: edit-in-place or release for normal final   │    │
│  └────────────────────────▲─────────────────────────────────┘    │
│                           │ append({event, name, args, phase})   │
│  ┌─ ProgressLineFormatter ─────────────────────────────────┐    │
│  │  • detailMode: explain | raw                            │    │
│  │  • emoji map per tool kind (bash/read/write/web/mcp/…)  │    │
│  │  • truncation rules                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
│                           ▲                                       │
│  ┌─ Dispatcher (src/index.ts:processGroupMessages) ────────┐    │
│  │  • on each runner JSON event, route to draft.append()   │    │
│  │  • thinking/answer paths stay untouched                 │    │
│  └─────────────────────────────────────────────────────────┘    │
└──────────────────────────┬───────────────────────────────────────┘
                           │ ContainerOutput envelopes (stdout JSON)
┌──────────────────────────▼───────────────────────────────────────┐
│ RUNNER (container/agent-runner-ghc/src/)                         │
│  • SDK onEvent → forwards into ContainerOutput.event             │
│  • new envelope kinds: tool_start | tool_progress | tool_done    │
│    plus plan, approval, command, subagent (later)                │
│  • shape kept minimal + stable so CC runner can mirror it        │
└──────────────────────────────────────────────────────────────────┘
```

### IPC envelope (added to `ContainerOutput`)

```ts
interface ContainerOutput {
  status: 'success' | 'error' | 'thinking' | 'progress';   // + 'progress'
  // existing fields unchanged …
  progress?:
    | { kind: 'tool_start';    toolCallId: string; toolName: string; mcpServerName?: string; arguments?: Record<string, unknown>; }
    | { kind: 'tool_progress'; toolCallId: string; message: string; }
    | { kind: 'tool_done';     toolCallId: string; success: boolean; error?: string; };
}
```

Rationale: keep `progress` an opt-in side field, never overwrite
`result`/`partial`. Host-side parser already drops unknown fields safely.

### Config

Per-channel `streaming.mode` borrowed from OpenClaw spelling so muscle memory
holds:

```jsonc
// ~/.nanoclaw/nanoclaw.json
{
  "channels": {
    "telegram": {
      "streaming": {
        "mode": "progress",        // off | partial | progress (no `block` — fork has no block delivery)
        "progress": {
          "label": "auto",         // false | "auto" | "Static text" | { pool: [...] }
          "maxLines": 4,
          "initialDelayMs": 5000,
          "detail": "explain"      // explain | raw
        }
      }
    }
  }
}
```

Defaults match OpenClaw: `auto` label from a short pool, 5 s delay, 5 lines,
explain detail. `mode` defaults to `off` so this is opt-in for v1.

### Channel transport matrix

| Channel  | Draft transport | First cut |
|----------|-----------------|-----------|
| Telegram | `sendMessage` then `editMessage` (already exists) | ✅ v1 |
| Teams    | Reuse `TeamsStreamingSession` (live stream, just shipped) | ⚠️ v1b — needs phase-machine extension or a second informative stream slot; defer to a follow-up commit unless trivial |
| (future) | Discord/Slack/Matrix not in fork scope | n/a |

### Thinking-vs-progress separation

- `<think>` continues to use the legacy flash dismissal path on Telegram and
  the new `appendThinking`/`commitAnswer` phase machine on Teams.
- Progress draft is a **separate** message (Telegram) or a **separate** field in
  the same stream (Teams, TBD). Never share state with `flashThinkingDismissed`
  / `nativeOnThinkingPrefix`.
- Owner can keep `reasoning=on` + `streaming.mode=progress` simultaneously: 2
  visible artifacts (thinking bubble + progress draft) + the final answer.

## Plan (single PR `chore/2026-05-23-progress-drafts`)

Commits, in landing order:

1. **(VM)** Runner: extend `onEvent` in
   `container/agent-runner-ghc/src/index.ts` to map
   `tool.execution_{start,progress,complete}` → new
   `ContainerOutput.progress` envelopes; wire into `writeOutput()`. +
   `container-runner.test.ts` covering parse of the new envelope.
2. **(VM)** Host: `src/channels/types-extensions.ts` adds
   `ChannelStreamingProgressConfig` + `Channel.supportsProgressDraft?`. Resolver
   helpers in `src/streaming-config.ts` (new file or extend existing).
3. **(Rpi5)** Host: `src/progress-draft.ts` — `ProgressDraftSession` class
   (open-gate, append, truncate, finalize, release). Pure unit-test friendly.
4. **(Rpi5)** Host: `src/index.ts` dispatcher branch — on
   `result.progress`, route to `ProgressDraftSession.append()` for current
   chatJid. Behind the per-channel `streaming.mode === 'progress'` gate.
5. **(Rpi5)** Telegram channel: wire `editMessage` into draft transport (no
   new method needed — `ProgressDraftSession` just calls
   `channel.sendMessage` + `channel.editMessage`).
6. **(VM)** CC runner stub: same envelope shape from `PreToolUse`/`PostToolUse`
   hooks. Behind a runtime flag, default off, so CC E2E behavior is unchanged
   until kenan asks for it.
7. **(VM)** Doc: this file → "Status: implemented v1" + mini user-facing
   `docs/users/progress-drafts.md`.

Tests:
- Unit: progress-line formatter (explain/raw, truncation, emoji map).
- Unit: `ProgressDraftSession` open-gate (delay+work-event), append/dedup,
  finalize edit-in-place vs release.
- Unit: dispatcher branch with mocked channel.editMessage.
- Smoke: kenan on Telegram, `mode=progress`, ask for a tool-heavy task →
  one bubble updates with `🛠️ …` lines, final answer replaces it.

Out of scope for this PR:
- Teams draft (commit deferred unless trivial — Teams needs design re: native
  stream slot sharing).
- Discord/Slack/Matrix (not in fork).
- Rich Block Kit lines (Slack-only; not in fork).
- Persistent draft history / replay.

## Open questions

1. **Q1 — finalize policy on Telegram**: edit draft into final answer (and
   lose the progress trail) vs. always send a fresh final reply and trim draft
   to "✅ done"? OpenClaw default is edit-in-place; kenan preference?
2. **Q2 — work-event gate**: 5 s delay matches OpenClaw default. Too long for
   our snappy Telegram flow? Kenan to call (default = ship 5 s, tune later).
3. **Q3 — Teams in v1?**: include Teams transport this PR (extra commit,
   another phase-machine seam) or defer to a follow-up so PR stays focused?
   Recommendation: **defer**. Teams just stabilized.

## Verification before merge

- `npm test` 1463+ pass (new suites added)
- `npm run build` clean
- Real-machine smoke: Telegram tool-heavy prompt, owner observes one
  edited progress bubble + final answer

## References

- OpenClaw doc: `~/.npm-global/lib/node_modules/openclaw/docs/concepts/progress-drafts.md`
- OpenClaw streaming types: `~/.npm-global/lib/node_modules/openclaw/dist/channel-streaming-DeWT18LP.d.ts`
- GHC SDK events: `container/agent-runner-ghc/node_modules/@github/copilot-sdk/dist/generated/session-events.d.ts:2067-2280`
- CC SDK hooks: `container/agent-runner/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts:721`
- Current runner onEvent registration: `container/agent-runner-ghc/src/index.ts:399`
- IPC marker + `ContainerOutput` shape: `container/agent-runner-ghc/src/index.ts:38-69`
