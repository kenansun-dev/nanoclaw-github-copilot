# Phase B.5-prep #2: v2 Router Landscape Audit

> **Author**: VM, 2026-04-28 02:42 GMT+8
> **Anchored at**: `15ef663` (post-cut-list)
> **Companion to**: `docs/v2-migration-inventory.md` "Phase B.5-prep: dispatcher cut-list" (rpi5)
> **Purpose**: Map what currently exists on v2-merge for "the v2 router" surface so the B.5 author knows exactly what to *write* (vs what already exists and just needs *wiring*).

This audit complements rpi5's cut-list, which lists what v1 dispatcher
calls need to be rerouted. This doc lists what v2 already has on the
receiving side and what's still missing.

## Summary

**There is no `src/router-v2.ts` file on v2-merge today.** The closest
analogues are:

| Surface                                  | Where                                           | State                                  |
| ---------------------------------------- | ----------------------------------------------- | -------------------------------------- |
| Channel adapter contract                 | `src/channels/adapter.ts`                       | ✅ defined (ChannelSetup + InboundEvent) |
| Channel registry + setup loop            | `src/channels/channel-registry.ts` (127 L)      | ✅ defined (`initChannelAdapters`)       |
| Side-effect adapter barrel               | `src/channels/adapters-barrel.ts` (B.4-finish)  | ✅ defined                               |
| Inbound write to messages_in             | `src/session-manager.ts:writeSessionMessage`    | ✅ defined                               |
| Resolve channel-tuple → session/agent_group | `src/session-manager.ts:resolveSession`       | ✅ defined                               |
| Outbound write from container            | `src/db/messages-out.ts:writeMessageOut`        | ✅ defined                               |
| Outbound delivery loop (poll messages_out → adapter.deliver) | (none on v2-merge) | 🔴 missing                             |
| **Host-side bootstrap that calls `initChannelAdapters` and supplies `setupFn`** | **(none on v2-merge)** | 🔴 **MISSING — this is the core B.5 deliverable** |
| Router state for cron/heartbeats         | `src/db.ts:getRouterState/setRouterState`       | ✅ defined (KV pair, fork-introduced)    |
| Fork `src/router.ts`                     | (formatter only — XML escape, formatMessages)   | ✅ retained, **misnamed** for our purpose |

## Key insight: "router" is two responsibilities

The cut-list (rpi5) treats the v2 router as a single surface that
exposes hooks like `registerAccessGate / registerAbortHandler /
registerAdminCommand / registerSlashCommandHandler`. That's correct
for the **inbound** half. But B.5 also needs to land an **outbound
delivery loop** that the v1 dispatcher implicitly handles inline.

### Inbound half (well-defined, mostly there)

```
Channel platform
  └─ ChannelAdapter.setup(setupFn)
       └─ adapter calls setupFn.onInboundEvent(event)
            ├─ accessGate(event) ─ may reject + write rejection to
            │  messages_out
            ├─ abortGate(event) ─ may early-return killing in-flight
            │  agent runs
            ├─ adminCommandRouter(event) ─ /clear /compact /context
            │  /cost /files /remote-control etc
            ├─ slashCommandRouter(event) ─ fork-style /clear and
            │  custom slash commands (delegates to fork
            │  src/slash-commands.ts)
            └─ resolveSession(channelType, platformId, threadId)
                 └─ writeSessionMessage(agent_group_id, sessionId, ...)
                      └─ messages_in row appears; container sees it
```

What's missing for B.5: the box that wraps the `setupFn` body (the
"setupFn" itself) plus the four hook registries. ~150-300 LOC of glue.

### Outbound half (NEEDS DESIGN)

```
Container writes messages_out row (writeMessageOut)
  └─ ??? polls messages_out.status='pending' WHERE delivery_at<=now
       └─ resolves channelType + platformId + threadId from session_routing
            └─ getChannelAdapter(channelType).deliver(...)
                 └─ marks row delivered
```

The middle box doesn't exist on v2-merge. Either:

- **Option A (poll-based, like fork)**: `setInterval(deliveryTick, 250ms)` reads pending rows, dispatches, marks delivered. Simple, matches fork's `outboundQueue` semantics. Handles container restarts naturally.
- **Option B (event-based)**: Container fs-notifies host on write. Lower latency but adds another IPC surface — doesn't fit "DB is the only IO" v2 axiom.

**Recommendation**: Option A. Keeps the DB-as-bus invariant; v1
`outboundQueue.ts` is already battle-tested at this loop shape, can
port the body wholesale into `src/router-v2/delivery.ts`.

## Hook interfaces — concrete proposed signatures

(Aligned with rpi5 cut-list rows. Type-only sketch; B.5 author owns
final shape.)

```ts
// src/router-v2/index.ts (proposed module path)

export interface AccessGate {
  (event: InboundEvent): Promise<AccessDecision>;
}
export type AccessDecision =
  | { allow: true }
  | { allow: false; rejectReason: string; sendRejection?: boolean };

export interface AbortHandler {
  /** Return true to short-circuit routing (message handled). */
  (event: InboundEvent, ctx: RouterCtx): boolean | Promise<boolean>;
}

export interface AdminCommandHandler {
  command: string; // exact match e.g. '/clear' '/remote-control'
  handler: (event: InboundEvent, ctx: RouterCtx) => Promise<void>;
}

export interface SlashCommandHandler {
  /** Fork hot-path for custom slash commands. Single entry; delegates internally. */
  (event: InboundEvent, ctx: RouterCtx): Promise<boolean>; // true = handled
}

export function registerAccessGate(fn: AccessGate): void;
export function registerAbortHandler(fn: AbortHandler): void;
export function registerAdminCommand(h: AdminCommandHandler): void;
export function registerSlashCommandHandler(fn: SlashCommandHandler): void;

export interface RouterCtx {
  resolveSession: typeof resolveSession;
  writeSessionMessage: typeof writeSessionMessage;
  getActiveAdapters: typeof getActiveAdapters;
  // Plus DB handles wired in by bootstrap:
  inboundDb(agentGroupId: string, sessionId: string): Database;
  outboundDb(agentGroupId: string, sessionId: string): Database;
}

/** Bootstrap entry point that wires everything and then calls
 * initChannelAdapters with the constructed setupFn. */
export async function startRouter(): Promise<void>;
```

## Bootstrap migration plan (B.5)

Single-line cut at `src/index.ts` startup:

```diff
- // v1 dispatcher
- await startV1Dispatcher();
+ // v2 router
+ import './router-v2/registrations.js'; // side-effect: registers all gates/handlers
+ await startRouter();
```

`router-v2/registrations.js` is the single import that triggers all
fork module side-effect registrations:

```ts
import './adapters-barrel.js'; // → registers Discord/Telegram/Teams adapters
import { registerAccessGate } from './index.js';
import { isSenderAllowed } from '../modules/sender-allowlist-fork/index.js';
import { isAbortRequestText } from '../modules/abort-fork/index.js';
import { ipcFork } from '../modules/ipc-fork/index.js';
// ... etc
registerAccessGate((event) => isSenderAllowed(event.senderId)
  ? { allow: true }
  : { allow: false, rejectReason: 'sender not allowlisted' });
registerAbortHandler((event) => {
  if (isAbortRequestText(event.message.content)) {
    killActiveAgent(event); return true;
  }
  return false;
});
ipcFork.startIpcWatcher(buildIpcDeps());
// ...
```

## Open questions for B.5 author

1. **Does outbound delivery loop live in `router-v2/delivery.ts` or as a separate `delivery-tick.ts` started by `startRouter`?** I'd vote separate file because it's the only piece with a `setInterval` lifecycle.
2. **Rate-limit / retry policy for outbound delivery on transient channel failures**: fork has a `send-with-retry.ts` (already in `src/channels/`); B.5 should reuse it instead of reimplementing.
3. **Cancel-in-flight semantics**: when AbortHandler fires, do we (a) kill the container ipc pipe, (b) mark the messages_in row 'aborted' so container's poll-loop sees it next tick, or (c) both? Cut-list assumes (a). Need to verify container side actually checks `status='aborted'` mid-run.
4. **Module bootstrap order**: current registry pattern relies on import-side-effects. If `router-v2/registrations.js` is imported before `adapters-barrel.js`, registration ordering may matter for some adapters' `onMetadata` early-fire. Need to either document the import order OR make registrations idempotent w.r.t. order.

## What's *not* in B.5 scope (per cut-list)

- `mount-security` — wire-up at C-step4 container launch, not router
- `mcp-auth` / `mcporter` — same (outbound credentials at container boot)
- `command-gate.ts` — fork-internal, used by admin command handlers, no router-level role
- `remote-control.ts` — moves into one `registerAdminCommand` call but the underlying spawn logic stays put
