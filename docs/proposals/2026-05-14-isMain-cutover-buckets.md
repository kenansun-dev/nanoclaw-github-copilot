# Step 3+4 — `isMain` / `registered_groups` cutover bucket plan

**Status**: planning, no code yet
**Owner**: Rpi5 (impl), VM (review + grep completeness)
**Branch**: `chore/2026-05-12-v2-schema-proposal` (current daily PR)
**Builds on**: `8e7c30d` (Step 1+2 — `roleBindings` + reconcile)

## Why a bucket plan first

`grep -rln isMain src/ --include="*.ts"` (excl. tests) → **170 hits across 20 files**.
`grep -rln 'registered_groups\|getRegisteredGroup\|registeredGroups' src/` → **95 hits across 23 files**.

Doing 170+95 ad-hoc replacements in one go = guaranteed missed semantics. The
field name `isMain` is **overloaded**: it means at least four different things
at the runtime call sites. Each meaning needs a different v2 helper.

Below: every call site bucketed by **what `isMain` actually means there**, plus
the v2 replacement. We commit one bucket at a time, each behind dual-read
shim so we can ship grey (new code reads v2, old code keeps reading v1) per
kenan's constraint #5.

---

## Bucket A — Mount permission (which workspace dir gets mounted)

**Semantic**: "this chat owns the `main/` workspace dir; non-main chats get `global/` (read-only by default)."

**v2 replacement**: a chat is "main-mounted" when its messaging-group has a
binding to the **default agent** (`agents.list[]` where `default:true`, else
`list[0]`). One mga per agent_group per messaging_group; the default agent's
mga is the one that gets `main/` mount.

| File | Lines | Current call | Proposed v2 helper |
|---|---|---|---|
| `src/container-runner.ts` | 53, 96, 102, 281, 377, 397, 589, 736 | `input.isMain` controls `/workspace/main` vs `/workspace/global` | `mgaIsDefaultAgent(mgaId)` |
| `src/host-runner.ts` | 187, 407 | `groupType = group.isMain ? 'main' : 'global'` | same helper |
| `src/mount-security.ts` | 225, 283, 325, 338 | `validateMount(mount, isMain)` — gate on read-only allowlist for non-main | rename param `isDefaultAgentBinding` (no logic change), feed from helper |
| `src/index.ts` | 240, 1041 | CLAUDE.md template path: `main/CLAUDE.md` vs `global/CLAUDE.md` | same helper |
| `src/db.ts` | 51, 57, 68, 72, 83, 86 | `loadChatsConfigSnapshot` derives folder from isMain (DM share-main collapse) | `getMessagingGroupFolder(channel, peerId)` reads from `messaging_groups` row + mga |
| `src/session-routing.ts` | 5, 8, 43, 56 | DM session collapse for share-main | same |

**Dual-read shim**: `mgaIsDefaultAgent(mgaId)` reads new mga; if no row, falls
back to legacy `getRegisteredGroup(jid).isMain`. Log a `warn` on fallback so
we can grep the warn count and prove cutover is complete before deleting v1
read.

---

## Bucket B — `/tasks` scope filter (UI)

**Semantic**: "main chat sees all tasks across folders; non-main chat sees only its own folder's tasks."

**v2 replacement**: filter by **whether the sender is owner**, not by chat
type. Owner sees everything; non-owner sees their own folder only. This is
also kenan's directive #3 ("IPC 跨 chat 特权检查改 `isOwner(userId)`").

| File | Lines | Current | Proposed |
|---|---|---|---|
| `src/slash-commands.ts` | 308–319 | `getRegisteredGroup(ctx.chatJid)?.isMain` → show all vs filtered | `isOwner(ctx.senderId)` |
| `src/cli/task.ts` | (registered_groups read) | similar UI filter | same |

---

## Bucket C — IPC privilege (cross-chat read/write/control from sandbox)

**Semantic**: "agent inside a main chat's sandbox can write/control any
folder; non-main agents can only touch their own folder."

**v2 replacement**: same as Bucket A — `mgaIsDefaultAgent(sourceFolder)` is
the privileged side (default-agent binding gets cross-folder write). IPC has
no human sender at the wire level (it's folder→folder), so the gate must
stay folder-keyed; we just swap the lookup source.

| File | Lines | Current | Proposed |
|---|---|---|---|
| `src/ipc.ts` | 23, 58, 61, 65, 80, 90, 98, 104, 113, 140, 221, 241, 308, 321, 334, 351, 393, 406, 415, 426 | `folder→isMain` map from `registered_groups` rows | `folder→isDefaultAgent` map built from `messaging_groups ⋈ messaging_group_agents` |

The `Defense in depth: agent cannot set isMain via IPC` block at line 415–426
becomes "agent cannot promote its mga to default-agent via IPC" — same
shape, just rename and read v2 table.

---

## Bucket D — Routing / engagement triggers

**Semantic**: "main chat doesn't need @-mention to respond; non-main does."

**v2 replacement**: this is **already** covered by `mga.engage_mode` (set by
reconcile from `accounts.*.groups.*.requireMention`, see Step 1+2 commit).
The remaining isMain reads here are dead weight — they shadow the mga
projection. Just delete the isMain branch; let mga drive.

| File | Lines | Current | Proposed |
|---|---|---|---|
| `src/index.ts` | 78, 295, 330, 1042, 1619 | `if (group.isMain) skip trigger` | delete; rely on `mga.engage_mode === 'pattern'` |
| `src/channels/tui.ts` | 35, 108, 120, 124 | TUI bootstrap stamps `isMain: true` | TUI bootstrap calls reconcile-style helper to ensure default-agent binding exists |
| `src/cli/tui-direct.ts` | 28, 364, 519, 527 | hardcoded `isMain: true` on TUI sessions | same TUI helper |

---

## Bucket E — Chat lifecycle / `chat add --main` CLI

**Semantic**: "user-facing knob to mark a chat as main."

**v2 replacement**: `--main` flag on `chat add` becomes "create a binding
from this chat to the default agent + insert owner role for the sender". We
keep the flag name (UX), change what it writes.

| File | Lines | Current | Proposed |
|---|---|---|---|
| `src/cli.ts` | 820, 836, 857, 863, 864, 870, 876, 877 | `addChat(jid, name, { isMain })` writes registered_groups + config.chats | `addChat` writes messaging_groups + mga (default agent) + roleBindings entry |
| `src/chat-manager.ts` | 17, 25, 26, 30, 33, 37, 38, 70 | `deriveGroupFolder` based on isMain | folder name derived from messaging_group id |

---

## Bucket F — Doctor / invariant checks

**Semantic**: "warn if invariants are violated."

**v2 replacement**: rewrite checks against the v2 model.

| File | Lines | Current | Proposed |
|---|---|---|---|
| `src/doctor.ts` | 67, 75, 111, 113, 134, 136, 324, 327 | "multiple isMain groups" / "isMain mismatch between config + DB" | "multiple chats bound to default agent in same mga set" + "mga drift between bindings[] and DB" |

---

## Bucket G — Migration + reconcile + schema (already mostly done)

| File | Status |
|---|---|
| `src/db/v2-migrate-chats.ts` | already writes isMain → roleBindings (Step 1+2). After Bucket E lands, bindings[] also gets written. |
| `src/config-loader.ts` | schema field `ChatEntry.isMain?: boolean` already `@deprecated`. Will be **deleted** after all read-sites cut over. |
| `src/db/migrations/102-fork-registered-groups.ts` | keep (history). Bucket I (below) adds migration 108 to drop the table. |

---

## Bucket H — `chat-reconcile.ts` — entire file becomes obsolete

`src/chat-reconcile.ts` exists solely to keep `config.chats[].isMain` and
`registered_groups.is_main` in sync. After Bucket E, both sources go away.
The whole file gets deleted at the end of Step 4.

26 isMain refs concentrated here, gone in one delete.

---

## Bucket I — Schema deletes (LAST — gates on greens above)

After Buckets A–H land, the v1 fields can be physically removed:

1. Schema delete: `ChatEntry.isMain`, `RegisteredGroup.isMain` (if still in `types-extensions.ts`)
2. New migration `108-drop-registered-groups.ts`: `DROP TABLE registered_groups`
3. Delete `src/modules/registered-groups-extensions/`
4. Delete `src/chat-reconcile.ts`
5. Delete `getRegisteredGroup` shim from `src/db.ts`

Tests that read `registered_groups` directly (e.g. `chat-reconcile.test.ts`)
get deleted with the file.

---

## Commit / PR plan (all in current daily PR)

1. **commit B+C+D first** (UI/IPC/routing — no schema risk, easy revert)
2. **commit A** (mount permission — most complex, isolated commit)
3. **commit E+F** (CLI + doctor — UX-visible, careful messaging)
4. **commit H+I** (deletes — only after `grep -rn isMain src/ --include='*.ts' | grep -v test` returns 0 outside the deletes themselves)

Between each commit:
- `npm test` green
- `nanoclaw doctor` no new warnings
- spot-check live tg/teams chat survives reconcile + boot

---

## Grep completeness — VM please double-check

```bash
grep -rn "isMain" src/ --include="*.ts" | grep -v ".test.ts" | wc -l   # 170
grep -rn "registered_groups\|getRegisteredGroup\|registeredGroups\b" src/ --include="*.ts" | grep -v ".test.ts" | wc -l   # 95
```

Things I might have missed and want VM eyes on:
- Dynamic property access like `group['isMain']` — ripgrep-resistant
- String-built SQL referencing `is_main` column
- `JSON.stringify` paths that emit `isMain` to disk (snapshots, IPC payloads)
- Anything in `container/agent-runner/` that reads back the `isMain` snapshot
  written by `writeGroupsSnapshot` / `writeTasksSnapshot`

If VM grep finds new sites → add a row to the right bucket above before I
start commit 1.

### Grep results (2026-05-15 self-run, awaiting VM second pass)

**Found 3 cross-process surfaces literal grep `isMain` missed**:

1. **`is_main` SQL column** (Bucket A/I): `src/db.ts:247-251` (DDL +
   backfill), `src/db.ts:859,887,921` (SELECT/INSERT). Migration 108
   in Bucket I needs `DROP COLUMN is_main` before `DROP TABLE`.

2. **`NANOCLAW_IS_MAIN` env var** (cross-process snapshot wire — **new
   Bucket J**): host stamps env var on container spawn
   (`container/agent-runner-ghc/src/index.ts:424`). Container reads in:
   - `container/agent-runner/src/ipc-mcp-stdio.ts:23,178,224,271,297,323,388,429`
   - `container/agent-runner-ghc/src/ipc-mcp-stdio.ts:25` (mirror)
   - `container/agent-runner-ghc/src/mcp-tools/server.ts:35`

   Used to: (a) gate `target_group_jid` cross-folder access, (b) filter
   `current_tasks.json` reads, (c) emit IPC `isMain: String(isMain)`
   header back to host, (d) hide group registration commands. **All
   four are the same semantic as Bucket A** (default-agent binding =
   privileged). Replace env var with `NANOCLAW_IS_DEFAULT_AGENT=0|1`
   stamped from `mgaIsDefaultAgent(mga)`. Container code keeps the same
   shape — just rename the constant.

3. **`available_groups.json` / `current_tasks.json` snapshot files**
   (Bucket A consumer side): writer at `container-runner.ts:734,776`
   filters tasks/groups by `isMain` boolean param. Reader at
   `container/agent-runner/src/ipc-mcp-stdio.ts:213,224`. Snapshot
   payload shape itself does **not** carry `isMain` field — only
   filtering on write side. Replacing writer's `isMain` param with
   `isDefaultAgent` is sufficient; on-disk JSON shape unchanged.

**Updated commit plan**: add Bucket J (env var rename) **between A and
E**, requires coordinated host + container/agent-runner-ghc + container/agent-runner
build (3 packages). Suggest splitting into J1 (host renames + writes
both env vars during transition) and J2 (containers read new var, host
drops old). This is the only commit needing container rebuild.

### Grep negative — NOT found anywhere
- `group['isMain']` (any quoted dynamic access) — 0 hits
- IPC envelope carrying `senderUserId` / `userId` from sandbox to host —
  **0 hits**, confirms Bucket C **must** stay folder-key. Open Q
  pre-decided in favor of (i).

---

## Open question for kenan / VM (one)

Kenan said "isOwner(userId)" for IPC privilege (#3). But IPC at the wire is
folder→folder, no userId on the sandbox side. Two options:

- **(i)** keep folder-keyed (Bucket C as written): default-agent binding =
  privileged folder. Simpler, matches current shape. **Recommended**.
- **(ii)** put owner userId in the IPC envelope from agent → host: every IPC
  call carries `senderUserId`, host gates on `isOwner(uid)`. Cleaner per
  kenan's wording but requires agent-runner protocol bump (more risk).

I'm going with (i) unless told otherwise.
