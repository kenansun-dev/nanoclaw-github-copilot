# DM Session Sharing — Spec

**Status**: drafted 2026-04-21, pending impl
**Owner**: VM Claw (impl), Rpi5 Claw (review)
**PR**: appended to today's daily PR (`chore/2026-04-21-merge-upstream-and-share-main`)

## Goal

Let multiple direct-message chats (Telegram DM, Discord DM, TUI) belonging to the **same agent** collapse onto one session — sharing history, MEMORY.md, and mounted folder. Group/channel chats stay isolated. Different agents stay isolated.

## Resulting properties

1. **DMs share a session** — within an agent, all `isMain: true` DMs hit one session
2. **Groups/channels stay independent** — never collapse, regardless of `isMain`
3. **Agents stay isolated** — collapse is bucketed by `agentId`

`sessionKey = (agentId, dm-or-specific-group)`

## Design (Option C.3, agreed with rpi5)

DB stores per-chat unique folders (satisfies existing `registered_groups.folder UNIQUE` constraint). A fork-only collapse layer in `db.ts`'s read path rewrites in-memory `group.folder` to the canonical `'main'` (or `'main-<agentSlug>'`) before upstream `index.ts` consumes it.

### Naming

`deriveGroupFolder(jid, chatConfig)` — DB-write side (already fork-only):

| Chat                                         | DB folder                            |
| -------------------------------------------- | ------------------------------------ |
| First isMain DM, default agent               | `main`                               |
| Subsequent isMain DM, default agent          | `main-d-<channel>-<idHash>`          |
| First isMain DM, agent `atlas`               | `main-atlas`                         |
| Subsequent isMain DM, agent `atlas`          | `main-atlas-<channel>-<idHash>`      |
| Group/channel (any)                          | unchanged (existing logic)           |

`<channel>` = short channel slug (`tg`, `dc`, `tui`); `<idHash>` = first 8 chars of `sha256(jid)`. Combined length ≤ 64 chars (validated by `isValidGroupFolder`).

### Collapse layer

```ts
// src/session-routing.ts (new, fork-only)
export function collapseMainDmFolder(
  group: RegisteredGroup,
  chatConfig?: { agentId?: string },
): string {
  if (group.isMain && !group.isGroup) {
    const agentId = chatConfig?.agentId;
    return agentId ? `main-${agentSlug(agentId)}` : 'main';
  }
  return group.folder;
}
```

Hooked into `db.ts` exports (already fork-patched file):

```ts
// src/db.ts (fork-only patch)
export function getAllRegisteredGroups(): Record<string, RegisteredGroup> {
  const raw = /* existing query */;
  const result: Record<string, RegisteredGroup> = {};
  for (const [jid, group] of Object.entries(raw)) {
    const chatConfig = loadConfig().chats[jid];
    result[jid] = { ...group, folder: collapseMainDmFolder(group, chatConfig) };
  }
  return result;
}

export function getRegisteredGroup(jid: string): RegisteredGroup | undefined {
  const raw = /* existing query */;
  if (!raw) return undefined;
  const chatConfig = loadConfig().chats[jid];
  return { ...raw, folder: collapseMainDmFolder(raw, chatConfig) };
}
```

### Queue key

`GroupQueue` currently keys by `groupJid`. Two isMain DMs with different jids but same collapsed folder would race writing the shared session store. Change key from `groupJid` to `group.folder` (post-collapse).

Fork-only — `src/group-queue.ts` is fork-only.

### isMain singleton invariant (PR #15) — relaxation

Current rule (`reconcileChatRegistry`): "at most one chat globally with `isMain: true`".

New rule: **per (agentId, isGroup=true) bucket, at most one isMain.** That is:
- Multiple isMain DMs allowed (collapse handles them)
- At most one isMain group/channel per agent (kept defensive, prevents accidental cross-context bleed)

Doctor `drift` check updated to match.

## Files touched

| File                       | Tracking         | Changes |
| -------------------------- | ---------------- | ------- |
| `src/db.ts`                | fork-patched     | wrap 2 read fns w/ collapse |
| `src/chat-manager.ts`      | fork-only        | `deriveGroupFolder` per-agent secondary naming |
| `src/group-queue.ts`       | fork-only        | key from `groupJid` → resolved folder |
| `src/session-routing.ts`   | new, fork-only   | `collapseMainDmFolder`, `agentSlug` |
| `src/chat-reconcile.ts`    | fork-only        | relax singleton invariant |
| `src/doctor.ts`            | fork-only        | drift check matches new invariant |
| `src/index.ts`             | upstream         | **0 changes** |
| `src/container-runner.ts`  | upstream         | **0 changes** |

## Tests

- `default-agent-dms-collapse.test.ts` — tg-main + dc-main + tui-main → all `'main'`, share `sessions['main']`
- `agent-atlas-dms-collapse.test.ts` — atlas-tg + atlas-dc → both `'main-atlas'`, isolated from default
- `groups-do-not-collapse.test.ts` — isMain group → keeps own folder
- `queue-serializes-shared-session.test.ts` — two collapsed DMs receive simultaneous messages → serialized via folder key
- `db-uniqueness-preserved.test.ts` — DB row count = chat count, no UNIQUE collisions
- Update `doctor.test.ts` drift check fixtures
- Update `chat-reconcile.test.ts` for new invariant

## Migration

- Existing single-isMain chat → DB folder already `'main'` → no change
- No data migration needed
- New isMain DMs get secondary names automatically via `deriveGroupFolder`

## Out of scope

- Cross-channel DM scope config (`dmScope`) — punt to future PR
- `chat migrate-session` command — punt
- Multi-agent simultaneous routing improvements (already works via existing `agentId` field)

## Open questions

### Resolved during 2026-04-21 design session
- **`RegisteredGroup` has no `isGroup` field.** Authoritative is-group source is `chats.is_group` column, populated by channel adapters at metadata time (see `storeChatMetadata`). Plan: `collapseMainDmFolder` performs a JOIN read against `chats.is_group` rather than a missing field on `RegisteredGroup`. Avoids jid-prefix heuristics (rejected as fragile).
- **No first-vs-subsequent canonical specialness.** All isMain DM folders in DB get unique names (e.g. `main-<jid-hash>`); collapse-on-read maps them all to canonical `'main'` (or `'main-<agent>'`). `deriveGroupFolder` returns unique-per-jid for isMain DMs — no state lookup needed at write time. Existing DB rows with `folder='main'` still work (collapse is identity for them).

### Edge cases to verify in PR review
- What if user manually edits `isMain` mid-session for an existing DM? (Existing behavior: re-derive folder on next sync — should still work since collapse is read-side.)
- Does `setRegisteredGroup` need to reject collapsed folders to prevent foot-guns? (Probably yes — assert input is the *unique* folder, not the canonical.)
- DB query overhead: collapse calls `chats.is_group` lookup per group. For startup `getAllRegisteredGroups()` (called twice in `index.ts`), batch into one JOIN query, not N+1.
