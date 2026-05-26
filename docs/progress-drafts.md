# Progress drafts: in-chat tool-call status

**Status**: implemented v1 (GHC runner only; Telegram + any channel with `editMessage`).

A *progress draft* is a single chat message nanoclaw edits while a turn runs,
showing the tools the agent is using right now — separate from the answer and
the `<think>` bubble. By default it is **progress** on channels that support
editing (e.g. Telegram). Set `channels.<name>.streaming.mode = "off"` to
opt out, or use `/streaming off` per chat.

Example bubble while a tool-heavy turn runs:

```
Cooking…
🛠️ Bash: npm test
🛠️ Read: src/index.ts
🛠️ Grep: function processGroup
```

Once the turn finishes, the same bubble flips to a compact summary:

```
Cooking…
✅ 3 done
```

…and the agent's actual answer arrives as a new message after it.

## Enable it

Add a `streaming.mode` block to the channel you want it on. Telegram example:

```jsonc
// ~/.nanoclaw/nanoclaw.json
{
  "channels": {
    "telegram": {
      "enabled": true,
      "streaming": {
        "mode": "progress",
        "progress": {
          "label": "auto",          // or false to hide, or "Working on it…" string
          "maxLines": 4,            // tool lines visible below the label
          "initialDelayMs": 5000,   // wait this long after 1st tool before opening
          "detail": "explain"       // "explain" (default) | "raw"
        }
      }
    }
  }
}
```

Restart nanoclaw. Ask the agent something tool-heavy (e.g. *"run the test
suite and grep for X"*). One bubble should appear and update while it works.

## What each option does

| Field | Default | Meaning |
|---|---|---|
| `mode` | `"progress"` | `"off"` (no draft), `"partial"` (legacy answer streaming, unchanged), `"progress"` (this feature, the new default) |
| `progress.label` | `"auto"` | Top line. `"auto"` rotates from a small pool (`Working…`, `On it…`, `Cooking…`, …). `false` hides it. Any string is taken literally. |
| `progress.labels` | (built-in pool) | Pool used when `label === "auto"`. |
| `progress.maxLines` | `4` | Max tool lines visible. Older done lines drop off first; in-flight lines never drop. |
| `progress.maxLineChars` | `120` | Per-line truncation length. |
| `progress.initialDelayMs` | `5000` | Wait after the first tool event before opening the bubble. The 2nd distinct tool always overrides the delay and opens immediately. `0` opens on the first tool event. |
| `progress.detail` | `"explain"` | `"explain"` shows a human-readable summary (`Bash: run tests`). `"raw"` appends raw args (`Bash: run tests, node --check /tmp/app.js`). |

## What you'll see per tool

The agent's tool calls are mapped to short titles + emoji:

| Tool kind | Line example |
|---|---|
| Bash | `🛠️ Bash: npm test` |
| Read / Write | `📖 Read: src/index.ts`, `✏️ Write: foo.ts` |
| Grep | `🔎 Grep: function processGroup` |
| WebSearch / WebFetch | `🌐 WebSearch: "openclaw release notes"` |
| MCP tool (`server.tool`) | `🔌 server.tool: …` |
| Unknown | `🛠️ Tool: …` |

If the MCP server reports its own progress (`progressMessage`), that text
overrides the args summary while the call is mid-flight:

```
🛠️ web_search: fetched 12 of 40 results
```

On completion:
- `✅ Bash: npm test` for success
- `❌ Bash: npm test — error: <short message>` for failure (60-char trim)

## What the bubble does on turn end

Today (v1):
- If the draft was ever opened, it is edited one final time into a release
  summary (`✅ N done` / `✅ N done, ❌ M failed`).
- The agent's real answer arrives as a **separate** new message right after.
- If the draft never opened (sub-delay turn with 0 or 1 tool), nothing extra
  is sent.

The proposal allows an `edit-in-place` policy that would fold the answer into
the same bubble, but v1 always uses `release` so the answer is never lost
inside an editable draft. The shape is preserved (`progress.finalizePolicy`
is read), so a future phase can flip it without a config migration.

## Independence from `<think>`

This lane is **completely orthogonal** to thinking:

- `agents.defaults.showThinking: "flash"` keeps streaming the reasoning
  one-liner into its own bubble, then dismissing it.
- `agents.defaults.showThinking: "on"` keeps prepending the full thinking
  text to the final answer.
- `agents.defaults.showThinking: "off"` keeps the answer thinking-free.

In all three modes, `streaming.mode: "progress"` adds the tool draft on top.
You can run all three at once (think bubble + progress bubble + answer).

## Channel support

| Channel | v1 |
|---|---|
| Telegram | ✅ (uses `sendMessage` + `editMessage`) |
| Discord, Slack, Mattermost, … | ✅ as long as the channel implements `editMessage` |
| Teams | ❌ deferred (needs native streaming slot extension; see proposal Q3) |

Channels without an `editMessage` capability silently fall back to `mode: "off"`
even when configured — no error, no broken bubble.

## Runtime support

| Runner | v1 |
|---|---|
| GHC (`@github/copilot-sdk`) | ✅ — `tool.execution_start` / `tool.execution_progress` / `tool.execution_complete` + `tool.user_requested` |
| CC (`@anthropic-ai/claude-agent-sdk`) | ❌ deferred — hook support exists (`PreToolUse`/`PostToolUse`), but the CC runner uses a detached DB-polling IPC path that doesn't share the GHC progress envelope yet. |

Existing CC-based groups are completely unaffected (`mode: "progress"` simply
has no source events to draw, so nothing shows up).

## Troubleshooting

**Nothing happens when I enable it.** Check:
1. The channel actually supports `editMessage` (Telegram does).
2. Your prompts trigger tools. A plain "hi" never opens a draft.
3. `agents.defaults.showThinking` is not eating the entire turn (a 1-tool
   turn that completes within `initialDelayMs` won't open one — by design).

**The bubble is stuck halfway.** A 429 / network blip is logged + swallowed
(`progress-draft: editDraft failed (non-fatal)`); the next event re-attempts
the edit. The draft is best-effort UX and never aborts the agent's turn.

**I want to see args verbatim.** Set `progress.detail: "raw"`.

## References

- Design proposal: `docs/proposals/2026-05-23-progress-drafts.md`
- Host session class: `src/progress-draft.ts`
- Channel transport adapter: `src/progress-draft-transport.ts`
- Config resolver: `src/streaming-config.ts`
- IPC envelope shape: `src/container-runner.ts` (`ContainerProgressEnvelope`)
- GHC runner event wiring: `container/agent-runner-ghc/src/index.ts`
