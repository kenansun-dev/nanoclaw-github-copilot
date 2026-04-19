# Proposal: chat SSOT consolidation

**Status**: Draft (open questions, no code yet)
**Filed by**: Rpi5 + VM cross-review during PR #14, 2026-04-19
**Triggered by**: kenansun observation that `nanoclaw doctor` and `status`
chat counts disagree with reality.

## Problem

Three independent stores hold "what chats does nanoclaw know about", with
no synchronisation between them:

| Store | Location | Populated by | Read by |
|---|---|---|---|
| `config.chats` (per-channel) | `~/.nanoclaw/nanoclaw.json` `channels.<x>.chats[]` | manual yaml edit + `chat-manager.addChat()` | `doctor`, `config get`, runtime routing |
| `registered_groups` table | sqlite `messages.db` | `addChat()` (via the DB call inside chat-manager that nobody traced) | `chat-manager.listChats()` ⇒ `nanoclaw chat list` |
| `chats` table | sqlite `messages.db` | inbound message handler (auto) | `chat-manager.listPendingChats()` (currently `return []` stub) |

Observed on rpi5 today (PR #14 baseline):

- `config.chats`: empty (`null` in every channel)
- `chats` table: 31 rows (telegram + teams + tui auto-observed)
- `registered_groups`: present but `nanoclaw chat list` shows nothing
- `nanoclaw doctor`: "0 explicit chats — telegram/teams accept incoming
  without registration ⚠️"

The doctor warning is *technically* accurate against `config.chats`, but
the user has been "registering" chats and the DB has remembered them —
the warning still fires because `addChat()`'s config write and
`listChats()`'s DB read don't talk to each other.

## Why this isn't fixed in PR #14

PR #14 already touches memory subsystem + doctor across 9 commits. Adding
schema consolidation (delete a table, migrate 31 rows, rewire chat-manager,
update routing call sites) would push the PR into "everything changed a
little" review territory. Memory + doctor are independently shippable;
chat SSOT is an architectural fix that benefits from its own PR with
focused review.

## Proposed direction

Make `config.chats` the single source of truth for "registered" chats.
The DB `chats` table stays as runtime cache of "every chat we've ever
seen incoming traffic from"; `registered_groups` table goes away.

| Concern | After |
|---|---|
| `nanoclaw chat add` | writes `config.chats` only |
| `nanoclaw chat list` | reads `config.chats` only |
| `nanoclaw chat pending` | reads `db.chats` minus `Object.keys(config.chats)` |
| `nanoclaw chat remove` | edits `config.chats`; leaves `db.chats` alone (history) |
| `doctor` | reads `config.chats`, count is now meaningful |
| Routing decisions (`isMain`, `triggerPattern`, …) | read `config.chats[jid]` |

## Open questions (must resolve before coding)

### 1. `isMain` semantics (memory subsystem coupling)

PR #14 ships `ensureDailySummaryTask` keyed on `chatJid` — one cron + one
daily note per chat. If `isMain: true` on a chat means "this chat speaks
for the whole group", does the daily summary:

- (a) stay per-chat (current; `isMain` only affects routing hints), or
- (b) move to per-group (`folder`-keyed) and only run when at least one
  `isMain` chat in that group has activity?

(b) reduces noise (one daily note per group vs N per chat) but couples
memory directly to group routing. Pick before chat SSOT lands so we know
what `isMain` *means* operationally.

### 2. `chats × registered_groups` join key

`db.chats.jid` is currently the only key. `registered_groups.jid` same.
But config supports a chat appearing under multiple channels with the
same suffix (`tg:8731187021` vs `teams:8731187021` is fine; what about
`tg:daily:8731187021` vs `tg:8731187021` — same user, different "view"?).

Decide: SSOT key is `(channel, jid)` composite, not bare `jid`. Schema
migration must dedupe accordingly.

### 3. Migration path for existing deployments

rpi5 has 31 `chats` rows + N `registered_groups` rows. After this PR
merges, what happens on first launch?

- (a) Auto-import all `registered_groups` into `config.chats` (+ keep
  backup of pre-migration JSON for rollback)
- (b) Print a one-time advisory "run `nanoclaw chat import-from-db` to
  migrate" and leave config untouched
- (c) Same as (a) but only for groups with `isMain=true` (assume the
  rest were exploratory)

Default behaviour matters because users who upgrade silently will lose
or gain registered chats depending on the choice. (a) is safest if we
write a backup first.

### 4. `containerConfig` per-chat

`registered_groups.container_config` is JSON blob. If we move it to
`config.chats[jid].containerConfig`, schema validation + JSON Schema
hints become possible — good. But it bloats nanoclaw.json for users
who don't customise. Decide: optional with sensible default merge, or
warn on bare-array config that's missing it?

## Out of scope for this proposal

- Multi-tenant config split (per-user nanoclaw.json) — orthogonal
- Chat *deletion* tombstoning — separate concern; current `chat remove`
  is fine for SSOT consolidation
- Telegram topics / Discord threads as sub-chats — already routed via
  routing.ts; SSOT concerns the parent chat only

## Next step

Land PR #14 first. Then file a fresh PR with:
1. Decisions on the 4 open questions above (kenansun + both agents)
2. Schema migration script (`nanoclaw migrate chat-ssot`)
3. `chat-manager.ts` rewrite (config-only writes, config-only `listChats`)
4. `listPendingChats` real impl (DB diff)
5. Routing call sites updated to read config not DB
6. `registered_groups` table dropped (kept in migration script for one
   release, then removed in the following one)

Estimated size: ~400 LOC + ~200 LOC tests.
