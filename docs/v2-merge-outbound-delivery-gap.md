# v2-merge B.5 adjacent gap: outbound delivery loop

> **Author**: VM, 2026-04-28 02:48 GMT+8
> **Anchored at**: `9064103` (post-rpi5 #2)
> **Companion to**: `docs/v2-migration-inventory.md` "Phase B.5-prep #2: dispatcher hook registries (design)" (rpi5)
> **Status**: superseded landscape audit slimmed down to a single
> finding rpi5's #2 doesn't cover.
>
> **Correction (VM, 2026-04-28 04:12 GMT+8)**: original framing of
> this file overstated the gap as "no code on v2-merge polls
> messages_out / no deliverer." That was wrong — `src/delivery.ts`
> already implements the deliverer. The real gap is **wire-up only**:
> the deliverer's startup functions are exported but never called.
> Section "Outbound delivery loop — corrected framing" below replaces
> the original "missing surface" wording. Original wording preserved
> below it for history. Lesson recorded in MEMORY.md (-3 self): grep
> with `--include='*.ts' | grep -v db/` excluded `src/db/session-db.ts`
> which holds the `messages_out` SQL helpers, leading to a false
> "no FROM messages_out" claim.

## Why this file exists (history)

Initial commit `3c2f44f` here was a parallel "router landscape audit"
written before rpi5's `9064103` registry-pattern reframe landed. Their
reframe is the canonical design (registries, no router class). All
hook-signature content from this file's first version is **dropped**
in favor of rpi5's signatures.

What survives is one finding rpi5's #2 doesn't cover: **the existing
outbound delivery loop in `src/delivery.ts` is dormant on v2-merge** —
its `startActiveDeliveryPoll()` / `startSweepDeliveryPoll()` entry
points are exported but never called from production code. B.5's
`src/index.ts` startup block must call them, otherwise `messages_out`
rows accumulate forever with no deliverer at runtime.

## Outbound delivery loop — corrected framing

### What's already on v2-merge

`src/delivery.ts` (476L) implements the full deliverer:

- `startActiveDeliveryPoll()` — schedules `pollActive()` every 1s
  (`ACTIVE_POLL_MS = 1000`), iterates `getRunningSessions()` and
  awaits `deliverSessionMessages(session)`.
- `startSweepDeliveryPoll()` — schedules `pollSweep()` every 60s
  (`SWEEP_POLL_MS = 60_000`), iterates `getActiveSessions()` for
  the slower catch-up sweep.
- `deliverSessionMessages(session)` (L173) — opens the session's
  `outbound.db` read-only, reads pending rows via
  `getDueOutboundMessages`, dispatches through the registered
  delivery adapter, and writes outcomes via `markDelivered` /
  `markDeliveryFailed` in `inbound.db`'s `delivered` table.
- SQL helpers live in `src/db/session-db.ts` (`getDueOutboundMessages`,
  `getDeliveredIds`, `markDelivered`, `markDeliveryFailed`,
  `migrateDeliveredTable`) — NOT in a separate
  `src/db/messages-out.ts`. Earlier drafts of this doc named that
  path; it does not exist.

All five outbound producers (`scheduling/actions.ts`,
`agent-to-agent/agent-route.ts`, `approvals/response-handler.ts`,
`self-mod/apply.ts`, `agent-to-agent/create-agent.ts`) ultimately
funnel through `writeSessionMessage()` in `src/session-manager.ts`
(the single `INSERT INTO messages_out` site in production code), so
the existing `delivery.ts` already covers all of them — no
producer-specific worker is needed.

### What's missing on v2-merge

`startActiveDeliveryPoll` / `startSweepDeliveryPoll` have **zero
production callers**:

```
$ grep -rn "startActiveDeliveryPoll\|startSweepDeliveryPoll" src/ \
    --include='*.ts' | grep -v "^src/delivery"
(empty)
```

`src/delivery.test.ts` exercises `deliverSessionMessages` directly,
which is why the polls being dormant doesn't show up in tests.

### Recommendation (replaces "B.5 should add `src/delivery-tick.ts`")

**Do not** add a new `src/delivery-tick.ts` / `modules/delivery-tick/`
module. The deliverer already exists.

**Do** add to the B.5 dispatcher startup block in `src/index.ts`,
alongside the side-effect imports and `initChannelAdapters(...)`
call (rpi5 #2 cut-list), an explicit pair of calls:

```ts
import { startActiveDeliveryPoll, startSweepDeliveryPoll } from './delivery.js';

// ... after channel adapters init + module barrels self-register:
startActiveDeliveryPoll();
startSweepDeliveryPoll();
```

Order: after `initChannelAdapters(...)` (delivery adapter must be
registered before polling starts) and after module barrels (so
modules that contribute to outbound — scheduling, agent-to-agent,
approvals, self-mod — are loaded before the first poll tick).
Drain on shutdown is already covered by `delivery.ts`'s internal
`activePolling` / `sweepPolling` flags plus the `onShutdown`
callback chain.

This is a B.5 cut-list addition, not a B.5-prep #4 registry concern,
and it doesn't gate on the four hook registries that B.5-prep #4
landed (`access-gate-registry`, `abort-handler-registry`,
`admin-command-registry`, `slash-command-registry`).

### Adjacent: `initChannelAdapters()` has no caller on v2-merge

`src/channels/channel-registry.ts:65` defines
`async function initChannelAdapters(setupFn)` but no production caller
exists yet:

```
$ grep -rn "initChannelAdapters" src/ --include='*.ts' | grep -v test
src/channels/channel-registry.ts:4: * The host calls initChannelAdapters() at startup
src/channels/channel-registry.ts:65:export async function initChannelAdapters(
```

The B.5 startup block in `src/index.ts` (per rpi5 #2 import-order block)
must call `initChannelAdapters(setupFn)` after the side-effect imports,
where `setupFn` builds the `ChannelSetup` object that calls
`onInbound → resolveSession → writeSessionMessage → run access gates →
abort handlers → admin commands → slash router → forward to LLM`.

In other words: rpi5 #2's "rewrites `src/index.ts` to consult them
[registries] instead of inline-importing fork modules" implicitly
requires writing this `setupFn` body. Worth calling out in the B.5
implementation checklist so it doesn't get missed alongside the
registry add-and-wire work.

---

## Original framing (preserved for history — superseded by correction above)

> Initial wording (commit `d460116`) — kept verbatim so reviewers can
> see the cycle. Do **not** act on this section; section "Outbound
> delivery loop — corrected framing" supersedes it.

### Symptom (original, incorrect)

`writeOutboundDirect` / `writeMessageOut` (in `src/session-manager.ts`
and `src/db/messages-out.ts`) write rows to `messages_out` from:

- `src/modules/scheduling/actions.ts:101`
- `src/modules/agent-to-agent/agent-route.ts:190`
- `src/modules/approvals/response-handler.ts:67`
- `src/modules/self-mod/apply.ts:50`
- `src/modules/agent-to-agent/create-agent.ts:30`

(plus container processes via the cross-mount DB).

**No code on v2-merge polls those rows** to dispatch them via
`getChannelAdapter(channelType).deliver(...)`. Search proof:

```
$ grep -rn "messages_out.*pending\|FROM messages_out" src/ \
    --include='*.ts' | grep -v test | grep -v migrations | grep -v db/
(empty)
```

Fork's `src/outboundQueue.ts` is the existing implementation — a 250ms
poll that selects pending rows, looks up the channel adapter, calls
`deliver()`, marks delivered. Battle-tested through fork's lifetime.

**Why this was wrong (correction note)**: The grep above pruned
`db/`, which excluded `src/db/session-db.ts` where the `messages_out`
SELECT helpers live (`getDueOutboundMessages`, etc.). The
`src/db/messages-out.ts` path cited in the producer list does not
exist; all `messages_out` SQL is in `src/db/session-db.ts`.
`src/delivery.ts` consumes those helpers from a `pollActive` (1s) +
`pollSweep` (60s) loop pair — see "What's already on v2-merge"
above.

### Recommendation (original, superseded)

B.5 should add `src/delivery-tick.ts` (or place it inside
`modules/delivery/`) that:

1. On startup, registers an `onDeliveryAdapterReady` callback (using
   the existing `src/delivery.ts` registry rpi5 #2 cites).
2. Inside that callback, starts a `setInterval(tick, 250)` loop.
3. Each tick: SELECT pending rows from `messages_out`, group by session
   to preserve order, dispatch via `getChannelAdapter(channelType).deliver(...)`,
   mark rows `delivered`, retry on `NetworkError` via the existing
   `src/channels/send-with-retry.ts`.
4. On host shutdown, drains in-flight ticks via `onShutdown` from
   `response-registry`.

This matches the four-registry pattern in rpi5 #2 (singleton, side-effect
self-register on import) — it just adds a fifth concern (the actual
delivery worker) that doesn't fit any of the existing four hooks.

**Why this was wrong (correction note)**: `src/delivery.ts` already
exists and already implements the entire worker. Adding a parallel
`delivery-tick.ts` would duplicate logic and create two pollers
racing against the same `messages_out`. Real fix is the two-line
wire-up in B.5's `src/index.ts` startup — see "What's missing on
v2-merge" above.
