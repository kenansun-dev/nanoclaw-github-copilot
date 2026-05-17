# TUI Dechannel — strip TUI from Channel registry

**Status:** draft (Rpi5 Claw, 2026-05-15)
**Owner ask:** "TUI 跟主 session 共享 OK，但不要以 channel 形式出现在 config 里" + 模仿 OpenClaw

## Today

`src/channels/tui.ts` implements `Channel` interface and self-registers via `registerChannel('tui', ...)`. Side effects:

- `TuiChannel.connect()` listens on `~/.nanoclaw/tui.sock` (Unix domain socket / Windows named pipe).
- Each TUI client connect → auto-registers stable jid `tui:default` via `opts.registerGroup` → entry shows up in `nanoclaw.json` under `chats['tui:default']`.
- Inbound client message → wrapped in `NewMessage` → `opts.onMessage` → goes through the same dispatcher pipeline as a real telegram/discord message.
- Outbound (agent reply) → router calls `channel.sendMessage(jid, text)` → JSON over socket back to the TUI client.

So today TUI is "just another channel adapter" in code shape, but semantically it's a local UI shell talking to the same agent.

## OpenClaw shape (reference)

`src/tui/` is **not** a channel. It's a UI runner (`runTui` in `src/tui/tui.ts`) that:

1. Connects to the gateway via `GatewayChatClient` (in-process or out-of-process).
2. Resolves a `sessionKey` for the current TUI session (`resolveTuiSessionKey`).
3. Sends `chat.send` RPC, receives streamed events, renders to the terminal.
4. No channel registry, no `nanoclaw.json` chat entry, no `Channel.sendMessage` hook.

The TUI is one of several UI surfaces (TUI, web, `acp`). They all talk to the gateway; channels are only for **external** message sources.

## Proposal

### Goal

`config.chats[]` no longer contains `tui:default`. The TUI talks to the agent via an in-process dispatch that bypasses the channel registry, while still sharing the **same agent session** as the main DM (so messages typed in TUI reach the same agent state as messages typed in `@kenan_vm_nanoclaw_bot`).

### Move

```
src/channels/tui.ts        (delete)
src/cli/tui.ts             (existing inkjs UI — keep)
src/cli/tui-direct.ts      (existing fallback — keep, simplify)
src/tui/                   (new: shared TUI infrastructure)
  ├── tui-dispatcher.ts    (in-process bridge: TUI ↔ agent)
  ├── tui-session.ts       (resolve session key for TUI)
  └── tui-types.ts
```

### In-process dispatcher

Today the path is `TuiChannel → onMessage → router → agent → channel.sendMessage`. New path:

```
TUI input → tuiDispatcher.send(text)
            → agent run (same handler used by router for channel messages,
              factored out of router into a `runAgentTurn(sessionKey, input)` helper)
            → stream callbacks (typing, partial, reply)
            → TUI render
```

No socket. No JSON wire protocol. TUI runs in the **same process** as the agent host (it's already invoked via `nanoclaw tui` which boots the daemon). `runAgentTurn` is a function call.

### Session sharing

Today: TUI registers `tui:default`, which maps to folder `main` after `collapseMainDmFolder` because `isMain: true` + DM. Agent session = whatever lives at `~/.nanoclaw/store/sessions/main/`.

New: `tui-session.ts` resolves the session key directly:

```ts
export function resolveTuiSessionKey(): string {
  // Same key the main DM uses → same session folder → same conversation state.
  return 'main';
}
```

No `collapseMainDmFolder`, no `tui:default` jid in `chats[]`. The folder lookup is explicit, not derived from a fake "channel jid".

This **kills the dependency** the share-main DM collapse machinery has on `isMain` / folder-name patterns. Once TUI is dechannelized, `collapseMainDmFolder` only needs to handle real DM channels (telegram, discord, signal, etc.).

### Telegram/Discord DM share-main (separate question)

The share-main DM behavior between **telegram DM ↔ tui** today happens because both jids collapse to folder `main`. After this change:

- TUI bypasses channel routing entirely → goes straight to `main`.
- Telegram DM still routes through `collapseMainDmFolder`. If owner wants `tg:8731187021` DM to also map to folder `main`, the collapse function needs the v2-clean reimplementation we discussed earlier (look up `messaging_groups` → `mga` → check default-agent + `chat_type='dm'`).

These are now two independent concerns instead of one tangled feature.

### Removed code

- `src/channels/tui.ts` whole file (~300 lines)
- `src/channels/registry.ts` no longer auto-loads tui
- `config-loader.ts` v8 migration: purge any leftover `chats['tui:default']` from existing user configs (one-time)
- `chat-manager.ts` / `chat-reconcile.ts` no longer special-case `tui:` prefix
- `audit.ts` source enum keeps `'tui'` (it's an audit actor source label, not a channel)

### Status enum

`'tui'` stays as a valid `actor.source` for audit logs — that's the surface label, not a channel adapter.

### Tests

- Delete `channels/tui.test.ts` (whole file — channel concept gone)
- Add `tui/tui-dispatcher.test.ts` covering: input → agent turn → stream → render callbacks
- `config-loader.test.ts` v7/v8 migration tests need updating: drop the "auto-register tui:default" expectation and add "purge legacy tui:default" expectation

## Risks

1. **Daemon vs in-process** — today `nanoclaw tui` starts the daemon then connects via socket, so a second `nanoclaw tui` can attach to a running daemon. New design assumes TUI is the **same process** as the agent; second concurrent TUI instance is not supported. If owner runs two TUI windows expecting both to see the chat, that breaks. Mitigation: keep the socket as a thin attach mechanism, but have the dispatcher (not a Channel) own it.

2. **Migration window** — users with existing `chats['tui:default']` in `nanoclaw.json` need a v8 migration that quietly drops it. No data loss; just the chat entry.

3. **Session collision** — if the agent already has a turn in flight (via telegram DM) and TUI sends another, both target session `main`. Today the channel router serializes via the queue. New design needs to use the same per-session queue helper (`AgentTurnQueue` or whatever exists), not bypass it.

## Coordination with VM's I-final work

VM is currently rewriting `src/channels/tui.ts` to drop `isMain` references (Path A, share-main DM via `legacyIsMainHint` private variable).

**Plan:**
1. Wait for VM to finish + push I-final to #49.
2. Rebase this proposal's commits on top.
3. The TUI dechannel deletes the file VM just edited — clean delete, not conflict resolution.
4. If VM's collapse rewrite ends up depending on a function the dechannel removes, fix in the rebase.

## Open questions for owner

(Carried over from previous TUI plan message — repeating for clarity.)

1. **Multi-window TUI** — do you ever run two `nanoclaw tui` at once and expect them both to see the same conversation? If yes, the dispatcher needs broadcast like today. If no, simpler.
2. **Telegram DM ↔ TUI share** — should typing in `@kenan_vm_nanoclaw_bot` and typing in `nanoclaw tui` reach the **same** agent session (today's behavior), or should they be separate? OpenClaw model is: separate. Your current model is: shared. Dechannel works either way; just need to know.

## Out of scope

- Rewriting TUI rendering (keep current ink-based UI).
- Changing the gateway/RPC story for `acp` and other surfaces.
- v2 schema work (VM owns).
