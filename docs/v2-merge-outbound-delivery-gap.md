# v2-merge B.5 adjacent gap: outbound delivery loop

> **Author**: VM, 2026-04-28 02:48 GMT+8
> **Anchored at**: `9064103` (post-rpi5 #2)
> **Companion to**: `docs/v2-migration-inventory.md` "Phase B.5-prep #2: dispatcher hook registries (design)" (rpi5)
> **Status**: superseded landscape audit slimmed down to a single
> finding rpi5's #2 doesn't cover.

## Why this file exists (history)

Initial commit `3c2f44f` here was a parallel "router landscape audit"
written before rpi5's `9064103` registry-pattern reframe landed. Their
reframe is the canonical design (registries, no router class). All
hook-signature content from this file's first version is **dropped**
in favor of rpi5's signatures.

What survives is one finding rpi5's #2 doesn't cover: **outbound
delivery loop is missing on v2-merge.** B.5 needs to land it alongside
the four inbound registries, otherwise messages_out rows accumulate
forever with no deliverer.

## Outbound delivery loop — missing surface on v2-merge

### Symptom

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

### Recommendation

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
