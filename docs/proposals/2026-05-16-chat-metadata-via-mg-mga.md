# Chat metadata cutover — `messaging_groups` + `messaging_group_agents`

**Date**: 2026-05-16  
**Author**: Rpi5 Claw  
**Status**: design (research only, no code yet)  
**Scope**: HR daily list item #2 — "agent 容器 chat 元信息全走 `messaging_groups` + `mga`"  
**Companion docs**: `2026-05-14-isMain-cutover-buckets.md` (just landed), `2026-05-16-isOwner-privilege-inventory.md` (VM, #3)

---

## Goal

Remove `registered_groups` as the chat-metadata source of truth. Container
already only sees a small env-var slice; the host derives that slice from
`registered_groups` today. After cutover the host derives it from the
v2 join `messaging_groups MG ⋈ messaging_group_agents MGA ⋈ agent_groups AG`,
and `registered_groups` is one PR away from `DROP TABLE`.

## What the container actually sees

`container/agent-runner-ghc/src/mcp-tools/server.ts:33-37`:

```ts
export const chatJid        = process.env.NANOCLAW_CHAT_JID!;
export const groupFolder    = process.env.NANOCLAW_GROUP_FOLDER!;
export const isDefaultAgent = process.env.NANOCLAW_IS_DEFAULT_AGENT === '1';
```

Plus `NANOCLAW_WORK_DIR` / `NANOCLAW_MEMORY_DIR` / `NANOCLAW_TZ` (path /
config — orthogonal, not part of this cutover).

Container does **not** read `containerConfig`, `trigger_pattern`,
`requires_trigger`. Those stay host-side.

## Where the host reads `registered_groups` today

| Site | Field consumed | Cutover target |
|---|---|---|
| `src/index.ts:102` boot-time hydrate | full row map | `MG ⋈ MGA` join (per-account) |
| `src/index.ts:1518, 1709` per-message refresh | full row map | same |
| `src/host-runner.ts:194` `resolveAgentForChat(input.chatJid)` | folder + agent | `MGA.agent_group_id` direct |
| `src/host-runner.ts:407` `input.isDefaultAgent` derivation | folder pattern | `AG.default = 1` flag |
| `src/doctor.ts:67, 328-357` consistency check | folder map | `MG.platform_id` map |
| `src/group-queue.ts:139+` `getGroup(groupJid)` | in-memory only | unchanged (uses jid as key) |
| `src/modules/registered-groups-extensions/index.ts` | re-exports `db.ts` API | re-point to MG-backed shim |

The narrow surface = the central read API
(`getAllRegisteredGroups` / `getRegisteredGroup`). If we replace those
two functions with an MG-backed implementation that returns the same
shape, every caller above transparently switches over.

## Field mapping

| Legacy `registered_groups` | v2 source | Notes |
|---|---|---|
| `jid` | `MG.channel_type ‖ ':' ‖ MG.platform_id` | already the shape we mint at write time |
| `name` | `MG.name` | 1:1 |
| `folder` | derived `<agentSlug>-<channel>-<8hex>` or `'main'` | computed, never stored on MG |
| `trigger_pattern` | `MGA.engage_pattern` | already migrated by `010-engage-modes` |
| `requires_trigger` | `MGA.engage_mode != 'always'` | derived |
| `container_config` | **gap** — see Open Q1 | currently only on legacy table |
| `added_at` | `MG.created_at` | 1:1 |

## Cutover plan (4 phases, mirrors the isMain bucket pattern)

### Phase 1 — dual-read shim (no behavior change)

- Add `src/v2-chat-metadata.ts` exporting `getAllRegisteredGroupsV2()` /
  `getRegisteredGroupV2(jid)` that build the same shape from MG ⋈ MGA.
- `getAllRegisteredGroups` (db.ts) becomes a thin facade:
  read both, log mismatches as `warn`, return v1 result. Same contract.

Risk: low. Read-only. Mismatches surface as warnings, fixable before next phase.

### Phase 2 — flip read primary

- Facade returns v2 result, falls back to v1 only when v2 row missing.
- Keep dual-write to `registered_groups` (so rollback = revert one commit).

Risk: medium. Any field gap shows up in container env. Mitigation:
exhaustive smoke run on rpi5 + VM with both default-agent DM and group
chats before merging.

### Phase 3 — stop writing `registered_groups`

- All `setRegisteredGroup` / `removeRegisteredGroup` mutate MG/MGA only.
- Legacy table becomes read-only legacy data.

Risk: medium-high. Rollback now requires backfill script. Add a one-shot
`scripts/backfill-registered-groups-from-mg.ts` for emergency use.

### Phase 4 — `DROP TABLE registered_groups`

- New migration `113-drop-registered-groups.ts`. Owner gates this
  separately (same pattern as the `is_main` column drop).

Risk: irreversible. Owner sign-off required, separate PR.

## Open questions for owner

**Q1 — `container_config` storage**:
Currently on `registered_groups.container_config` as JSON. Three
options:
- (a) add `MG.container_config TEXT NULL` column (1-line migration,
  back-compat)
- (b) move to `MGA.container_config` (per-agent override, more flexible
  but never used today)
- (c) drop the field — git log shows it was added for a never-shipped
  per-chat timeout feature, no live config writes it

**Recommend (c) unless someone disagrees in 24h** → cleanest cutover.

**Q2 — bidirectional warn during Phase 1**:
VM's isMain Bucket B used a bidirectional dual-read warn. I'll mirror
that (warn on v1↔v2 disagreement either direction) unless there's a
reason to drop noise floor.

**Q3 — rollback window**:
Phase 2 → Phase 3 = how long do we keep dual-write? Default 1 week,
matches the isMain cutover cadence.

## What this does NOT do

- Does not touch `agent_groups`, `users`, `user_roles` — those are
  VM's task #3 territory.
- Does not change container-side schema (env vars stay identical).
- Does not change channel registration UX (`/register` / `/control`).

## Next action

Owner reads + answers Q1 (container_config drop OK?). If yes, Phase 1
commit lands same day. Total cutover ETA: ~3 days (matches isMain cadence).
