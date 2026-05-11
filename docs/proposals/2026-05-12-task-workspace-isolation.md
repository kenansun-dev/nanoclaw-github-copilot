# Proposal: Task workspace isolation (Gap 3 follow-up to detached-tasks)

> **Status**: draft, awaiting kenan ✅ before implementation.
> **Author**: Kenan Rpi5 Claw, 2026-05-11.
> **Refs**: `docs/proposals/2026-05-11-detached-tasks.md`, PR #44 (`f744069`).

## 1. Problem

§4.1.A landed slot-key indirection so a scheduled task no longer occupies
the chat slot. Implication: **same chat can run multiple tasks in parallel**,
gated only by the global `MAX_CONCURRENT_CONTAINERS=5` ceiling.

But all of those parallel tasks still run against **the same `group_folder`
on disk** (mounted as `/workspace/group` in container mode, and the bare
host folder in host mode). That folder is also live for the chat itself.

So today, after PR #44, this is possible:

- Task A (cron `*/5 * * * *`): "regenerate `report.md` from current state"
- Task B (interval): "tail my notes file every 30s and append a TODO line"
- Chat user: "edit `report.md` to add my draft notes"

A and B and the chat can fire concurrently in three different agent
runners against the same folder. The agents have no protocol-level
awareness of each other; the only safety net is filesystem-level
last-writer-wins.

## 2. Why this didn't bite us before §4.1.A

Before detached tasks, scheduled tasks **always** ran on the chat slot. The
queue serialised them with chat messages, so we got "happens-before"
ordering for free at the granularity of the whole agent run. Workspace
shared, but never concurrent.

§4.1.A traded that serialization for responsiveness. We need to decide
what the corresponding workspace contract is.

## 3. Options

### Option A — Keep shared workspace (status quo)

- ❌ No isolation. Concurrent writes race.
- ✅ No schema change. No code change. Cheapest.
- ✅ Tasks that **want** to mutate persistent group state (canonical use
  case: daily summary appending to `MEMORY.md`) keep working.
- 🟡 Mitigation: document the race in `schedule_task` MCP tool description
  and in the new `nanoclaw task add` CLI. Recommend tasks own a single
  file (or directory) and use `mv` for atomic publish.

### Option B — Per-task workspace (always isolated)

- Each task run mounts `${groupFolder}/.tasks/${taskId}` instead of
  `${groupFolder}`. Task agent sees a clean, scoped fs.
- ✅ Strongest isolation. Two parallel cron tasks cannot collide.
- ❌ Breaks the existing daily-summary use case (task wants to write to
  group's `MEMORY.md`). Would need a manual `cp` or symlink convention.
- ❌ Breaks any task that needs to **read** chat context files (CLAUDE.md,
  installed skills, accumulated state).
- ❌ Schema change required (column to record what got mounted, or just
  rely on per-task convention).

### Option C — Schema-driven, opt-in isolation (recommended)

- Add `workspace_mode: 'shared' | 'isolated'` column to `scheduled_tasks`
  (default `'shared'` — preserves status quo for existing rows).
- `'shared'`: today's behavior (mount `groupFolder`).
- `'isolated'`: mount `${groupFolder}/.tasks/${taskId}/` as the task's
  working directory. Task can read group files via a read-only bind of
  `${groupFolder}` at `/workspace/group-ro` (container) or via an env
  var `NANOCLAW_GROUP_READONLY` pointing at the absolute path (host).
- Surface `workspace_mode` as an arg to `schedule_task` MCP tool and
  `nanoclaw task add`.
- ✅ Backward compatible (existing tasks: shared, same as today).
- ✅ Lets agent choose per-task. Daily summary stays shared. New "scrape
  HN every 5 min into a temp working set" can opt into isolated.
- 🟡 Schema migration (additive, default value). Cheap.
- 🟡 Container mount setup gets one extra bind in the isolated case.

### Option D — Slot-level lock (no workspace change)

- Keep workspace shared. Add a per-`group_folder` advisory lock taken
  at task spawn time. Concurrent task spawn for the same folder waits.
- ✅ Preserves shared workspace semantics (daily summary still works).
- ❌ Reverts the §4.1.A win — same-chat tasks serialise again.
  (The reason §4.1.A exists is precisely that we don't want this.)

## 4. Recommendation

**Option C, with `'shared'` as the default**. Reasoning:

1. Backward compatible by default — no behavior change for existing rows
   or for users who don't think about workspace isolation.
2. Gives users (and the task-creator agent) an explicit opt-in for the
   "I want to scratch around in my own sandbox" case.
3. Cost is small: one column + one branch in the spawn path.
4. Doesn't moot §4.1.A — both modes still run on detached slots.

## 5. Schema change (Option C)

```sql
ALTER TABLE scheduled_tasks
  ADD COLUMN workspace_mode TEXT DEFAULT 'shared';
```

Migration `104-fork-task-workspace-mode.ts`. No backfill needed.

## 6. Code touch points

- `src/types-extensions.ts` — add `workspace_mode?: 'shared' | 'isolated'`
  to `ScheduledTask`.
- `src/db.ts` — `createTask` writes the column; `updateTask` lets it be
  changed; SELECT\* picks it up automatically.
- `src/task-scheduler.ts` — pass `workspace_mode` through to the
  container input.
- `src/host-runner.ts` + `src/container-runner.ts` — when
  `workspace_mode === 'isolated'`:
  - **Host**: `cwd = path.join(groupFolder, '.tasks', taskId)`; `mkdir
-p` before spawn; expose `NANOCLAW_GROUP_READONLY = groupFolder` env.
  - **Container**: bind-mount `${hostGroupFolder}/.tasks/${taskId}` at
    `/workspace/group`, plus read-only bind of `${hostGroupFolder}` at
    `/workspace/group-ro`.
- `container/agent-runner-{ghc,}/src/mcp-tools/scheduling.ts` — add
  optional `workspace_mode` arg to `schedule_task`. Default `'shared'`.
- `src/cli/task.ts` — `--workspace-mode shared|isolated` flag on `add`.
- `container/agent-runner-ghc/src/index.ts` — extend the system-prompt
  hint added in this PR to mention `workspace_mode` semantics.

## 7. Cleanup

`${groupFolder}/.tasks/<taskId>/` accumulates per-run directories.
Sweep via existing `host-sweep.ts` cycle (add a new cleaner that
removes `.tasks/<id>/` older than `cleanupAfterDays`). Not in scope of
the implementation PR — can land alongside.

## 8. Open questions for kenan

1. **Default**: `'shared'` (recommended above) or `'isolated'` (safer,
   but breaks the daily-summary cohort silently)?
2. **Read-only group exposure** in isolated mode — yes/no? If yes, env
   var name (`NANOCLAW_GROUP_READONLY`) and container mount path
   (`/workspace/group-ro`) acceptable?
3. **`script` tasks** (rare path that sets `task.script`) — same
   workspace_mode semantics, or always shared?
4. **Cleanup policy** — delete old `.tasks/<id>/` after run, after N
   days, or never (user's responsibility)?

## 9. Out of scope (later, if needed)

- Cross-task coordination primitives (filesystem-level lock helpers,
  shared event bus). Probably never needed; if it is, design a separate
  proposal.
- "Marketplace" of task templates (Gap 4 from PR #44 follow-up).
