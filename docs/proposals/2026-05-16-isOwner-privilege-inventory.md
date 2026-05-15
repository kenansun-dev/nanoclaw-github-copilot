# IPC Cross-Chat Privilege → `isOwner(userId)` — Inventory

**Status**: research-only, no code changes
**Branch**: `chore/2026-05-12-v2-schema-proposal` (#49)
**Author**: Kenan VM Claw, 2026-05-16
**Context**: HR list item #3 ("IPC 跨 chat 特权检查 → `isOwner(userId)`")

## Current model (post-PR #49 / Path A)

The privilege predicate is **`isDefaultAgent: boolean`**, derived
*per-IPC-message* from the **source directory** (`ipcBaseDir/<folder>/...`).
Resolution path:

1. `ipc.ts` watcher reads `<folder>` from the path.
2. `folderIsDefaultAgent(folder)` (v2) returns true iff folder == chosen
   `agents.list[].default` id (or v2 `defaults.id`, fallback `'main'`).
3. The boolean is threaded through `processTaskIpc()`, `handleControlIpc()`,
   `handlePluginIpc()` and `container-runner` mount/task-filter code.

**Trust source**: filesystem path of the IPC drop. Whoever can write to
`ipc/<defaultAgentFolder>/messages/` is "main". No user identity check —
purely directory-keyed.

## Where `isDefaultAgent` gates today

### `src/ipc.ts` (host)
- `send_message` / `send_file` (dispatch to **other** chats) — line 77, 87, 95
- `nanoclaw_control` (restart, config changes) — line 101
- `nanoclaw_plugin` mutating actions (install/uninstall/marketplace_add/remove) — line 110
- Task IPC: `pause/resume/cancel/update/list` cross-folder access — lines 305, 318, 331, 348, 390, 403
- `register_group` self-write vs cross-write — line 412 area

### `src/host-runner.ts`
- groupType label `'main'` vs `'global'` (line 408) — affects logging/mount path

### `src/container-runner.ts`
- `buildVolumeMounts(group, isDefaultAgent, …)` — different mount set for default agent (line 96, 102)
- `RunnerInput.isDefaultAgent` env propagation to container (line 53, 281, 401)
- `formatTasksList` / `formatGroupsList` filter scope (lines 740–795) — default agent sees all groups/tasks

### `container/agent-runner-ghc/src/mcp-tools/`
- `core.ts:117` — gates a privileged tool (cross-chat)
- `scheduling.ts:126,174,200,224,245,266` — `target_group_jid` arg only honored when isDefaultAgent; task list scope; broadcast schedule

Total ≈ **37 sites** across host + container runner + GHC MCP tools.

## What changes with `isOwner(userId)`

The predicate switches from **"this folder is the default agent's"** to
**"the human triggering this action is the configured owner"**.

Consequences worth flagging *before writing code*:

### What's gained
- Decouples privilege from "default agent" naming. A non-default agent
  invoked by the owner can still do cross-chat / control ops.
- Enables multi-agent setups where the owner reaches privileged actions
  via the agent that's most ergonomic, not whichever one is `default: true`.
- Removes the last semantic dependency on the default-agent folder name
  for security decisions (after I-4..I-6 we still leak the concept here).

### What needs designing (open questions)
1. **Source of `userId` per IPC message.** Today IPC messages don't carry
   a user id — they're written by the agent container *on behalf of* a
   human turn. We need either:
   - a) Container records `triggering_user_id` per turn and stamps every
     IPC drop with it; host trusts the drop to be honest because the
     mount is per-folder and only that agent writes there.
   - b) Host correlates the IPC drop to the inbound message that started
     the turn (via run id / task id).
   - (a) is cheaper; (b) is more defensible against a compromised agent.
2. **Owner config schema.** Channels currently identify users with
   per-channel ids (`tg:123`, `dc:456`, `wa:+...`). `isOwner(userId)`
   needs a normalized id or a list of `{channel, id}` pairs in
   `config.access.owners` (or similar).
3. **Multi-owner**: are we OK with a list, or strictly one owner?
4. **Group chats with multiple humans**: if a non-owner triggers a turn
   in a group the agent watches, the IPC drops are not on behalf of the
   owner. Today this is fine because privilege is folder-keyed (group
   chats are not the default-agent folder). With user-keyed privilege,
   we must still gate group-chat invocations on owner identity.
5. **Container-side gates** (`agent-runner-ghc/mcp-tools`): same predicate
   currently boolean from env (`NANOCLAW_IS_DEFAULT_AGENT`). New env
   would be `NANOCLAW_TRIGGERED_BY_OWNER` per turn (re-set every dispatch),
   not at container start. That's a non-trivial wiring change vs the
   current static-env model.
6. **TUI** (Rpi5's dechannel work): TUI runs as the human directly — it
   should always be `isOwner=true`. Makes the in-process bridge cleaner.
7. **Doctor / mount-security**: these still rely on folder identity.
   Owner check is orthogonal — privilege is "what can run", not "where
   files live". Folder-based mount layout stays.

### Migration sketch
- **Phase 1**: introduce `isOwner` *alongside* `isDefaultAgent` (dual-read
  similar to Bucket H pattern). All gate sites become
  `isOwner || isDefaultAgent` so behavior is non-regressing for current
  deployments where the owner only talks to the default agent.
- **Phase 2**: add owner id config + per-turn user id propagation
  (decision needed: container-stamped or host-correlated).
- **Phase 3**: flip authoritative read to `isOwner`; keep
  `isDefaultAgent` only for folder-mount routing (not privilege).
- **Phase 4**: remove `isDefaultAgent` from the privilege predicate
  entirely; container env stops carrying it.

## Recommended call

Don't start until owner answers:
- (Q1) one owner or list?
- (Q2) which channel ids count as the same owner — explicit `{channel, id}` map vs first-class owner identity that channels declare into?
- (Q3) per-turn user id source — container-stamped (cheap) or host-correlated (robust)?

I'm parking here until owner replies. No code edits in this commit.

---

## Follow-up (2026-05-16, second pass)

After re-reading existing v2 RBAC code (`src/modules/permissions/db/user-roles.ts`,
`src/v2-access.ts`, `src/db/v2-reconcile.ts`), Q1 and Q2 are **already
answered by the schema we shipped**. Only Q3 actually blocks.

### Q1 — one owner or list? → **list, already supported**
- `user_roles` is a multi-row table keyed `(user_id, role, agent_group_id)`.
- `isOwner(userId)` (`user-roles.ts:36`) returns true iff *any* row exists
  with `role='owner' AND agent_group_id IS NULL`. No singleton constraint.
- `v2-reconcile.ts:151–188` syncs `commands.ownerAllowFrom: string[]` and
  `channels.<type>.roleBindings: Record<id, 'owner'|'admin'>` *as sets*.
- VM's live DB already has 2 owner rows (`telegram:8731187021`, `tui:default`)
  proving multi-owner runs.
- **Action**: drop Q1 from the open list.

### Q2 — channel-id normalization → **channel-qualified ids, already standard**
- Config schema already uses `<channel>:<id>` strings throughout
  (`telegram:8731187021`, `teams:29:abc`, `tui:default`). See
  `v2-reconcile.test.ts:284`.
- Same shape persists into `users.id` PK — no separate normalized identity
  layer needed.
- For cross-channel "same human" we don't need to invent identity
  unification: owner adds each channel-qualified id they want recognized.
  This is exactly what `commands.ownerAllowFrom` / `roleBindings` already do.
- **Action**: drop Q2 from the open list. If/when we want true identity
  unification (one human → many channel ids → single canonical owner row),
  that's a separate `accounts.<owner>.identities[]` proposal — out of scope
  for IPC privilege swap.

### Q3 — per-turn user id source → **still open, owner pick required**

This is the only real fork. Two options in detail:

**Option (a) Container-stamped**
- `agent-runner-ghc` records `triggering_user_id` from the inbound
  payload it processes for the current turn, then stamps every IPC drop
  it writes (`writeIpcFile` adds `triggering_user_id` field) before host
  reads it.
- Host trusts the field because the IPC dir is mounted per-folder and
  only that container writes there.
- Wire-format change: additive optional field; old host ignores it,
  new host treats missing field as "unknown user" → falls back to
  `isDefaultAgent` predicate (Phase 1 migration).
- Cost: ~30 LOC in `ipc-mcp-stdio.ts` + a per-turn ambient on the GHC
  runner.
- Risk: a compromised agent container can lie about `triggering_user_id`.
  But a compromised default-agent container can already do anything via
  the existing folder-keyed predicate — trust boundary unchanged.

**Option (b) Host-correlated**
- IPC drop carries only `task_id` / `run_id`. Host maintains a map
  `run_id → triggering_user_id` populated when the inbound message kicks
  off the run, looked up at IPC read time.
- No container wire change.
- More defensible: container can't lie, host alone authoritative.
- Cost: ~80 LOC + persistent map (or ephemeral but then host restarts
  lose privilege mid-task). State management is the real cost.
- Risk: race conditions between long-running tasks and host restarts.
  Either we persist the map (extra schema) or we accept that mid-task
  IPC after a host restart drops to `isDefaultAgent` fallback.

**My recommendation**: (a). The trust argument for (b) doesn't actually
buy us anything we don't already concede to the default-agent container,
and (a) is roughly 3× cheaper to ship + has zero new persistent state.
Owner can override.

### Open list, current state
- ~~Q1~~ resolved (list)
- ~~Q2~~ resolved (channel-qualified ids)
- **Q3** — owner pick: (a) container-stamped, or (b) host-correlated

### What I'll do once Q3 is answered
- Phase 1 commit: add `isOwner` predicate next to `isDefaultAgent` in
  every gate site listed above (`isOwner || isDefaultAgent`). Wire either
  the container-stamp field or the host-correlation map per Q3 answer.
  Tests for both branches of the OR.
- I will *not* flip the authoritative predicate in the same PR. Phase 3
  flip is a separate cycle once we have telemetry that the new path is
  hit in real traffic.

