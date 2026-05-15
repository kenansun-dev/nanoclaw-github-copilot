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
