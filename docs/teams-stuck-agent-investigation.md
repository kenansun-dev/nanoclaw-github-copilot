# Teams stuck typing + dropped messages — root cause + fix

## What kenan saw

```
03:25:26.285 INFO  New messages count=1
03:25:26.350 INFO  sendMessage: piped to IPC                     ← message handed to IPC
03:25:27.039 ERROR Agent absolute timeout reached, killing       ← agent SIGTERM'd 0.7s later
03:25:27.039 ERROR Host agent timeout, killing
03:25:27.049 INFO  Host agent process ended (output already delivered)
03:29:53.071 INFO  Teams message stored                          ← user retried 4.5 min later
```

Symptom: typing indicator stuck on, no reply ever arrives, the IPC-piped
message is silently lost.

## Root cause (three bugs stacked)

### Bug 1 — `absoluteTimeout` semantics wrong for IPC mode

`AGENT_RUN_TIMEOUT_MS` (default 600s) was set as a **lifetime cap** on the
host agent process, not a per-query budget. In IPC mode (`neverTimeout`)
the agent is expected to live across many user turns. After ~10 min of
total wall-clock time — even idle — the agent gets SIGTERM'd. If a user
happens to send a message in the seconds before the SIGTERM lands, the
IPC pipe succeeds, the agent is dead before it reads, and the message is
gone.

**Fix:** in IPC mode, `absoluteTimeout` is now a **per-query budget**.
`fs.watch` on the IPC input directory restarts the timer whenever a new
`*.json` IPC input file is renamed in. The query-complete signal
(`result===null && newSessionId && !partial`) pauses the timer until the
next IPC pipe.

### Bug 2 — cursor advanced before agent acknowledges

`index.ts` advances `lastAgentTimestamp[chatJid]` to the latest piped
message timestamp **immediately after** `queue.sendMessage()` returns
true. If the agent dies before producing output, the message is gone
from both the IPC dir (cleaned up in the exit handler) and from the
"new messages" cursor (already past it). The DB still has the row, but
nothing will ever read it.

**Fix:** `GroupQueue.sendMessage()` now accepts an optional `rollbackCursor`
parameter and stores the **earliest** in-flight piped cursor on the
group state. When the process dies before producing output for piped
messages, the new `onProcessDiedWithoutOutput(groupJid, rollbackCursor)`
listener (registered in `index.ts`) restores `lastAgentTimestamp` so the
next agent spawn re-reads the dropped messages.

### Bug 3 — exit handler missed the piped-then-died case

The previous `proc.on('exit')` handler in `group-queue.ts` only ran when
`state.active && state.idleWaiting`. But `sendMessage()` clears
`idleWaiting=false` at IPC pipe time. So when the agent died **after** a
pipe (Bug 1's exact scenario), the exit handler did nothing —
`state.active` stayed `true`, `state.process` stayed pointing at a dead
PID, and the next `sendMessage()` call rejected because
`process.exitCode !== null`. The message sat in the DB. Typing indicator
was never cleared because nothing on this code path knows it should be.

**Fix:** the exit handler now covers two cases:
1. **idle-then-died**: `idleWaiting=true`, no piped messages — clean up
   state, no rollback callback fires.
2. **piped-then-died**: `pipedSinceOutput > 0 && !agentHasOutput` —
   clean up state, fire the rollback callback so `index.ts` can roll the
   cursor back and clear the typing indicator.

The handler explicitly does **not** fire during the initial-query phase
(`state.active=true, idleWaiting=false, pipedSinceOutput=0`), where
`runContainer`'s finally block owns the cleanup. Double-cleanup there
would corrupt `activeCount`.

## Telemetry added

To make this class of bug greppable next time:

| Log line                                  | Where                      | When                                  |
|-------------------------------------------|----------------------------|---------------------------------------|
| `Channel typing state change`             | `index.ts traceSetTyping`  | every typing on/off, with `reason`    |
| `channel.setTyping failed`                | `index.ts traceSetTyping`  | typing call rejects                   |
| `Agent absolute timeout reached (IPC per-query)` | `host-runner.ts`     | per-query budget exceeded             |
| `Absolute timeout paused`                 | `host-runner.ts`           | agent enters idle-wait                |
| `IPC input received, restarting per-query timeout` | `host-runner.ts`  | fs.watch sees new IPC file            |
| `sendMessage: piped to IPC` (now includes `inFlightCursorRollback`) | `group-queue.ts` | every IPC pipe   |
| `Active process exited, releasing state` (with `case`, `hadInFlight`, `exitCode`) | `group-queue.ts` | process death |
| `Agent died with piped IPC messages in flight; rolled back cursor` | `index.ts` | rollback fires |

`reason` on typing transitions: `turn-start | progressive-first-partial
| final-output | turn-end | ipc-pipe | agent-died`. If the indicator
gets stuck again, grep for the last `Channel typing state change` —
whatever `reason` shows is the last code path that touched it.

## Verification

- `npm test`: 634/634 (was 630, +4 new tests in `group-queue.test.ts`
  covering the 4 process-died scenarios)
- TypeScript clean across all packages
- Per-query timeout exercised via fs.watch in IPC mode
- Rollback cursor: oldest in-flight wins (verified by test)
- Idle-clean exits don't fire callback (verified by test)
- No-pipe deaths don't fire callback (verified by test)
