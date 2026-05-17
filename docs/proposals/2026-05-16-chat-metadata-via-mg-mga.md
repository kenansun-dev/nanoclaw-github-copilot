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

## Where the host touches `registered_groups` today

**Verified by re-grep 2026-05-16 04:08 GMT+8.** 11 read calls / 3 write
calls across 9 files; central API = `db.ts` 4 functions.

### Read callers (11)

| File | Line | Call | Field consumed |
|---|---|---|---|
| `src/index.ts` | 102 | `getAllRegisteredGroups()` | full row map (boot hydrate) |
| `src/index.ts` | 1518 | `getAllRegisteredGroups()` | full row map (refresh) |
| `src/index.ts` | 1709 | `getAllRegisteredGroups()` | full row map (per-message) |
| `src/chat-manager.ts` | 86 | `getAllRegisteredGroups()` | folder uniqueness check |
| `src/chat-manager.ts` | 190 | `getAllRegisteredGroups()` | jid→folder lookup |
| `src/chat-reconcile.ts` | 45 | `getAllRegisteredGroups()` | reconcile config.chats |
| `src/chat-reconcile.ts` | 80 | `getAllRegisteredGroups()` | inverse pass |
| `src/cli/task.ts` | 232 | `getRegisteredGroup(jid)` | folder for task scope |
| `src/cli/task.ts` | 237 | `getAllRegisteredGroups()` | enumerate for `--all` |
| `src/doctor.ts` | 335 | `getAllRegisteredGroups()` | sync check vs config.chats |
| `src/session-overrides.ts` | 43 | `getRegisteredGroup(chatJid)` | folder for override key |

### Write callers (3)

| File | Line | Call | Trigger |
|---|---|---|---|
| `src/chat-manager.ts` | 94 | `setRegisteredGroup` | `chat add` reconcile |
| `src/chat-manager.ts` | 179 | `removeRegisteredGroup` | `chat remove` |
| `src/index.ts` | 233 | `setRegisteredGroup` | inbound `/register` |

### Indirect (host-runner via dispatch)

| File | Line | Path |
|---|---|---|
| `src/host-runner.ts` | 194 | `resolveAgentForChat(input.chatJid)` — folder lookup goes through `getAllRegisteredGroups` cache populated at index.ts:102 |
| `src/host-runner.ts` | 407 | `input.isDefaultAgent` — already off `v2-default-agent.ts`, no longer touches RG |

### Module re-export

`src/modules/registered-groups-extensions/index.ts` — re-exports the
4 `db.ts` functions verbatim. Phase 1 facade swap = single edit here
because it's the official extension boundary.

### The narrow waist

All 14 call sites flow through 4 `db.ts` functions:
`getAllRegisteredGroups` / `getRegisteredGroup` (read) and
`setRegisteredGroup` / `removeRegisteredGroup` (write). Replace those
4 with MG-backed implementations returning the same shape, and the
cutover is transparent to every caller.

## Field mapping

| Legacy `registered_groups` | v2 source | Notes |
|---|---|---|
| `jid` | `synthLegacyJid(MG.channel_type, MG.platform_id)` | **NOT raw `channel_type:platform_id` — see F1 fix below** |
| `name` | `MG.name` | 1:1 |
| `folder` | derived `<agentSlug>-<channel>-<8hex>` or `'main'` | computed, never stored on MG |
| `trigger_pattern` | `MGA.engage_pattern` | already migrated by `010-engage-modes` |
| `requires_trigger` | `MGA.engage_mode != 'always'` | derived |
| `container_config` | **gap** — see Open Q1 | currently only on legacy table |
| `added_at` | `MG.created_at` | 1:1 |

## F1 fix — jid prefix mismatch (VM-verified, blocking Phase 1)

**VM repro on live DB**: naive `MG.channel_type ‖ ':' ‖ MG.platform_id`
returns 0 matches against `registered_groups.jid`. Root cause:
`v2-migrate-chats.ts:66` `channelKeyToType` maps short prefix `tg` →
full name `telegram` when populating `MG.channel_type`. Legacy `rg.jid`
kept the short prefix. So the join key needs the **inverse** map
applied to the v2 side.

**Live jid samples on rpi5** (verified 2026-05-16 04:24 GMT+8 via
`messages.db / registered_groups`):

```
tg:8731187021                  → channelKey=tg,    platform_id=8731187021
teams:a:1Rw3-S4Le_...          → channelKey=teams, platform_id=a:1Rw3-S4Le_...   (2 colons)
tg:daily:8731187021            → channelKey=tg,    platform_id=daily:8731187021    (2 colons)
tui:default                    → channelKey=tui,   platform_id=default
teams:..., tui:..., dc:..., wa:..., etc.
```

Key insight: `splitJid` only splits at the **first** colon, so
`platform_id` can legitimately contain colons (Teams thread IDs,
daily-prefix Telegram chats). Inverse map must preserve that.

### `synthLegacyJid` helper spec

Add to `src/v2-chat-metadata.ts` (the new module created in Phase 1):

```ts
/** Inverse of channelKeyToType in v2-migrate-chats.ts:66.
 *  MUST stay in sync with that map. */
function typeToChannelKey(channelType: string): string {
  switch (channelType) {
    case 'telegram': return 'tg';
    // teams, discord, whatsapp, slack, imessage, email, matrix, tui:
    // legacy + v2 use the same string, no rewrite needed.
    default: return channelType;
  }
}

/** Compose a legacy-shaped jid from v2 (channel_type, platform_id).
 *  Used as the lookup key when bridging legacy callers to v2 rows. */
export function synthLegacyJid(channelType: string, platformId: string): string {
  return `${typeToChannelKey(channelType)}:${platformId}`;
}
```

**Phase 1 facade then becomes**:

```ts
function mgRowToLegacy(mg: MgRow, mga: MgaRow | null): RegisteredGroup & { jid: string } {
  return {
    jid: synthLegacyJid(mg.channel_type, mg.platform_id),
    name: mg.name ?? '',
    folder: deriveFolder(mg, mga),
    trigger: mga?.engage_pattern ?? '',
    requiresTrigger: (mga?.engage_mode ?? 'always') !== 'always',
    addedAt: mg.created_at,
  };
}

// Lookup: invert at query time, NOT at storage time
export function getRegisteredGroupV2(jid: string): RegisteredGroup | undefined {
  const [channelKey, platformId] = splitJidLegacy(jid);  // tg, 8731187021
  const channelType = channelKeyToTypeShared(channelKey); // telegram
  const mg = db.prepare(`SELECT * FROM messaging_groups WHERE channel_type=? AND platform_id=?`).get(channelType, platformId);
  // ...
}
```

### Cross-checks added to Phase 1 unit tests

- `synthLegacyJid('telegram','8731187021')` === `'tg:8731187021'`
- `synthLegacyJid('teams','a:1Rw3...')` === `'teams:a:1Rw3...'` (no rewrite)
- `synthLegacyJid('tui','default')` === `'tui:default'`
- Round-trip: every legacy jid in fixture DB ↔ (channel_type, platform_id) ↔ same legacy jid
- Drift counter (F4 fix): doctor counts mismatched rows, reports `"v1↔v2 chat-metadata drift: N rows"`

### Refactor `channelKeyToType` to shared module

Currently duplicated at `v2-migrate-chats.ts:66` and `v2-reconcile.ts:75`.
Phase 1 commit 0 = lift to `src/db/channel-key.ts` (no behavior change),
Phase 1 commit 1 = add `synthLegacyJid` consumer. Keeps the inverse
definition single-sourced — if anyone adds a new channel mapping
(e.g. nostr → ns), both directions update together.

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

## Findings folded in (VM review of `1baba9f` / `6fa17cc`)

- **F1** (jid prefix mismatch) — fixed above. Phase 1 blocker, resolved.
- **F2** (hot-path perf, dual-read 3-table join × per-inbound) — add
  facade-level memoization keyed on `MG.created_at MAX(MG.id)`
  invalidation. Required before Phase 2 flip; Phase 1 baseline numbers
  in PR description.
- **F3** (cross-dep landing order) — accepted.
  **Order: VM Phase 1 (additive `triggeringUserId` wiring) → Rpi5 Phase 1+2 (chat metadata cutover) → VM Phase 2 (isOwner flip)**.
  Reason: VM's Phase 1 is additive sibling param, Rpi5's Phase 2 changes
  `groupFolder` boot path; landing VM first avoids trampling wiring
  still in flux.
- **F4** (doctor blind to drift) — doctor adds dedicated
  `"v1↔v2 chat-metadata drift: N rows"` counter line, mirrors the
  retired `is_main` consistency check. Lands in same commit as Phase 1
  facade.

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
