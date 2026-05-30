# Teams streaming multi-final fix — 2026-05-29

## Symptom (kenan repro, 2026-05-28 Windows Teams client)

Single user message in a Teams DM produces 13–34+ separate DM bubbles in
reply. Bubbles contain coherent prose from one agent turn (often one
sentence per bubble). Log evidence:

- 1 inbound `Teams message stored`
- 1 `sendMessage: piped to IPC pipedSinceOutput=1` (no spawn duplication)
- 1 long-lived host agent (pid 23248 spawned 11:09:31, served all turns)
- 13–34 outbound `INFO Teams message sent jid=... length=...` per user
  message, each a distinct activity

So the issue is **not** session/agent duplication. It is one agent turn
emitting many discrete Teams messages.

## Two bugs, layered

### Bug 1 — streaming wire bootstrap reject (root cause)

Log shows, **before** the multi-final storm, repeated WARN:

```
Teams adapter turn error (streaming wire, suppressed user notice)
err="Only start streaming and continue streaming types are allowed as a typing activity"
```

`teams-streaming.ts` already implements the documented MS bootstrap
sequence (`streamType: 'informative'` → `streaming` → `final`, gated by
`_bootstrapSent`). But the server still rejects activities, which sets
`_cancelled = true` (see `_drainLoop` catch). After that the
`StreamHandle` is dead and `streamHandle.chunk()` becomes a noop (line
199: `if (this._ended || this._cancelled) return;`).

Probable causes (VM to confirm):
- `_streamId` never returned by server, so `_stampStreamId` doesn't run
  on continuation chunks → continuation rejected for missing streamId
- MS `@microsoft/agents-hosting` v1.x changed the required entity shape
- `prefersNewMessageForFinal` interaction with cancelled stream

Owner of Bug 1 fix: **VM** (per channel agreement 2026-05-29 00:05).

### Bug 2 — dispatcher multi-final amplifies cancelled stream (this PR)

`src/index.ts:946..985` handles `!result.partial` (final output):

```
if (streamHandle) { streamHandle.end(text); streamHandle = undefined; }
else if (progressiveMsgId && channel.editMessage) { ... }
else if (...prefersNewMessageForFinal === false) { editMessage }
else { channel.sendMessage(chatJid, text, sendOpts); }   // ← culprit
```

When Bug 1 has cancelled the stream:
- `streamHandle` may already be unset (or its `end()` is a noop)
- `progressiveMsgId` is empty (we never used edit path on streaming
  channels)
- Teams has `prefersNewMessageForFinal = true` → falls through to
  `channel.sendMessage`
- Each subsequent `result.result` with `!partial` (multi-step tool
  calls, multi-paragraph answers split into chunks by agent-runner)
  hits the same branch → **N final messages → N DM bubbles**

This is correct behaviour when each final is genuinely an independent
response (e.g. "tool call 1 result" + "tool call 2 result"). It is wrong
when streaming died mid-turn and the agent is still emitting its
single-answer narration.

## Fix

Track a per-turn flag `streamHandleDiedMidTurn`:

- Set when the streaming channel returned a non-noop handle, then
  `_cancelled` flipped before turn-end (detected via post-end inspect,
  or by treating a failed/noop `chunk()` as an implicit cancellation
  signal we propagate up).
- When set, the final-message branch (`!result.partial`) accumulates
  text into a per-turn `coalescedFinal` buffer instead of calling
  `channel.sendMessage` immediately.
- Turn-end (`agent.idle` / explicit terminator / `Active process exited`)
  flushes `coalescedFinal` as **one** `channel.sendMessage`.

Worst case under this fallback: 1 long DM instead of 34 short ones.
If Bug 1 is fixed, the fallback never triggers and behaviour is
unchanged.

### Surface area

- `src/index.ts` final branch: 30–50 LOC
- `src/types-extensions.ts` (or wherever StreamHandle is typed): add an
  `isCancelled()` / `wasReplaced()` query, or piggy-back on `chunk()`
  returning a boolean we already throw away
- `src/channels/teams-streaming.ts`: expose `cancelled` flag (already
  private `_cancelled`)
- New test in `src/channels/teams-streaming.test.ts` or
  `src/index.test.ts`:
  1. simulate streamHandle that cancels on second chunk
  2. fire 5 `result.partial=false` results
  3. assert exactly 1 `channel.sendMessage` call with concatenated text

## Out of scope

- Bug 1 (wire bootstrap) — separate commit by VM, same daily PR
- `host-sweep` `Database not initialized` noise — separate issue, does
  not affect message duplication (confirmed by log analysis: only one
  host agent spawned per teams JID per day)

## Open questions for VM

1. Does `streamHandle.end(finalText)` reliably publish a non-streaming
   plain message when `_cancelled === true`? If yes, Bug 2 may be
   mooted by routing all subsequent finals through `streamHandle.end`
   instead of `channel.sendMessage`.
2. Should the dispatcher recreate a fresh `streamHandle` on second
   partial after the first died? That would also coalesce, but doubles
   the risk surface if wire is fundamentally broken.

Decision needed before bug 2 code lands.
