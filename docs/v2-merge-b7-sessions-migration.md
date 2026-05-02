# B.7 cutover design: `sessions` table schema migration

> **Status**: draft / design only, not yet scheduled for implementation.
> **Author**: VM Claw, 2026-04-30 (post PR #36 merge follow-up)
> **Co-author**: RPI5 Claw (cross-review pending)
> **Triggered by**: schema-collision finding in `docs/v2-merge-triage-2026-04-30.md`
> § "Post-merge follow-ups" added in commit `357e99d`.

## Problem statement

Two `CREATE TABLE sessions (...)` definitions co-exist in the tree as of
`chore/2026-04-30-v2-mergeback @ 357e99d`. They share a name but are
schema-incompatible (different columns, different PK).

### v1 (fork, currently authoritative)

- Defined inline at `src/db.ts:146` (raw `database.exec` at startup)
- Plus an in-place migration block (`src/db.ts:171-198`) that adds the
  `provider` column and rebuilds the PK to `(group_folder, provider)` for
  databases predating GHC support.
- Schema:
  ```sql
  CREATE TABLE sessions (
    group_folder TEXT NOT NULL,
    provider     TEXT NOT NULL DEFAULT 'anthropic',
    session_id   TEXT NOT NULL,
    think_level  TEXT,
    model        TEXT,
    show_thinking TEXT,
    PRIMARY KEY (group_folder, provider)
  );
  ```
- **Live** today: every v1 dispatcher caller — `router.ts`, `delivery.ts`,
  `host-sweep.ts`, `host-core.ts`, `state-sqlite.ts`, `slash-commands.ts`,
  `task-scheduler.ts`, `ipc.ts`, `db.test.ts`.

### v2 (taken-upstream, currently dormant)

**Verified dormant 2026-04-30** by RPI5 smoke against `~/.nanoclaw-v2/data/nanoclaw.db`:
`Database initialized` log on boot comes from fork `db.ts:initDatabase()`
(v1 schema), and `initDb()` has zero non-`src/db/`-internal callers.

- Defined in two places for the upstream module-split:
  - `src/db/migrations/001-initial.ts:85` — runs via `runMigrations()` invoked
    from `src/db/connection.ts:initDb()`
  - `src/db/schema.ts:105` — declarative reference doc (not executed)
- Schema:
  ```sql
  CREATE TABLE sessions (
    id                 TEXT PRIMARY KEY,
    agent_group_id     TEXT NOT NULL REFERENCES agent_groups(id),
    messaging_group_id TEXT REFERENCES messaging_groups(id),
    thread_id          TEXT,
    agent_provider     TEXT,
    status             TEXT DEFAULT 'active',
    container_status   TEXT DEFAULT 'stopped',
    last_active        TEXT,
    created_at         TEXT NOT NULL
  );
  CREATE INDEX idx_sessions_agent_group ON sessions(agent_group_id);
  CREATE INDEX idx_sessions_lookup     ON sessions(messaging_group_id, thread_id);
  ```
- **Dormant** today: `initDb()` is not called from `src/index.ts` —
  `initDatabase()` (fork) is the only DB entrypoint at `src/index.ts:1667`.
  Foreign-key targets `agent_groups` and `messaging_groups` are also
  module-split tables that v1 dispatcher does not populate.

### Field correspondence (informal mapping)

| v1 column        | v2 column            | Notes |
|------------------|----------------------|-------|
| `group_folder`   | `agent_group_id` (FK)| v1 stores folder name as identity; v2 derefs through `agent_groups.id` (UUID) |
| `provider`       | `agent_provider`     | name change, but **also redundantly stored on `agent_groups.agent_provider`** (`src/db/migrations/001-initial.ts:14`). v2 has the field in two places — likely an override pattern (group default + per-session override), but canonical resolution rule is undocumented. See Q3. |
| `session_id`     | `id` (PK)            | v1 PK is `(folder, provider)`; v2 PK is `id` UUID |
| `think_level`    | (gone)               | v2 stores think config in `agent_groups` row, not per-session |
| `model`          | (gone)               | same |
| `show_thinking`  | (gone)               | same |
| (none)           | `messaging_group_id` | new in v2 — sessions know which channel surface they belong to |
| (none)           | `thread_id`          | new in v2 — sub-thread isolation within a messaging group |
| (none)           | `status`             | new in v2 — `'active'`/`'archived'`/etc |
| (none)           | `container_status`   | new in v2 — pulled out of `host-core.ts` in-memory state |
| (none)           | `last_active`        | new in v2 — for sweep / cleanup |
| (none)           | `created_at`         | new in v2 |

The mappings are **lossy in both directions**: v1→v2 needs invented UUIDs
plus a way to populate `agent_groups` / `messaging_groups` rows; v2→v1 loses
`thread_id`, `status`, `last_active`, `created_at`.

## Why this is dormant today

`runMigrations()` in `src/db/connection.ts` only runs if some caller invokes
`initDb()`. Today **no caller does** — the v1 entrypoint at
`src/index.ts:1667` calls `initDatabase()` from fork's `src/db.ts`. So
`001-initial.ts` never executes against a real SQLite file, and v1's
`sessions` table is the only one that exists on disk.

`grep -rn "initDb\b\|getDb\b" src/ | grep -v "src/db/"` confirms zero
non-`src/db/`-internal callers.

## Trigger event

The collision becomes a startup crash the moment **both** entrypoints run
against the same `nanoclaw.db`. Concretely, that happens when:

1. `NANOCLAW_V2_DISPATCHER` cutover lands and `src/index.ts` switches from
   `initDatabase()` to `initDb()`, **or**
2. Someone manually calls a v2 module function that internally calls
   `getDb()` before v1 has built its schema, **or**
3. A test in `src/db/*.test.ts` runs against a real SQLite that v1 has
   already touched.

Today (1) is gated, (2) doesn't happen because v2 modules have zero callers
in `src/index.ts`, and (3) v2 db tests use `initTestDb()` (in-memory).

## Options considered

### Option A — Drop+recreate during cutover

When the V2 dispatcher cutover migration runs:

1. Snapshot v1 `sessions` rows to a JSON file (e.g.
   `~/.nanoclaw/sessions-v1-export-<timestamp>.json`).
2. `DROP TABLE sessions`.
3. Run v2 `001-initial.ts` to create the new shape.
4. Reload from snapshot, mapping fields and inventing UUIDs.

**Pros**: ends with a single canonical `sessions` table.

**Cons**:
- Lossy: `messaging_group_id`, `thread_id` start NULL — sessions lose their
  channel context until they re-register.
- One-way: cannot fall back to v1 once `DROP TABLE` has run, even if v2
  cutover is later reverted.
- Race-y: if v1 dispatcher is still running on another process when the
  migration fires, the dropped table re-emerges with v1 schema again.

### Option B — Rename v2 table to `sessions_v2`

Rename the upstream module-split table at definition time so the two never
collide on disk.

1. Patch `src/db/migrations/001-initial.ts` and `src/db/schema.ts`:
   `CREATE TABLE sessions_v2 (...)`, `CREATE INDEX idx_sessions_v2_*`.
2. Patch `src/db/sessions.ts` (and any other module-split caller) to query
   `sessions_v2` instead of `sessions`.
3. v1 `sessions` table stays untouched until v1 dispatcher is fully
   removed; then a final cleanup migration drops it.
4. Optional one-way data sync at cutover (best-effort, append-only into
   `sessions_v2`) — not required for correctness because v1 sessions are
   ephemeral routing state, not user data.

**Pros**:
- v1 and v2 can coexist on the same DB indefinitely. Useful for staged
  cutover where some channels are v2 and others stay v1.
- Reversible: a regression on v2 can fall back to v1 instantly without
  data loss.
- Avoids the multi-process race in option A.

**Cons**:
- Two tables in the schema, slightly more confusing for contributors.
- Need to remember the cleanup migration after v1 fully retires.

### Option C — Same-name `sessions`, dual-shape with feature flag

Rejected outright. SQLite cannot have two definitions of the same table; we
would have to runtime-switch which `CREATE TABLE` runs based on the
dispatcher flag. That makes the schema migration history non-deterministic
and is exactly the kind of thing that bites in production six months later.

## Recommendation

**Option B (rename to `sessions_v2`)**, for the reversibility and staged-cutover
properties. The "two tables in schema" cost is paid for one cutover window;
the safety upside is paid forward across every channel migration.

## Implementation sketch (Option B)

When B.7 starts (separate PR, not this one):

1. **Schema patch** (single commit, expected **≈ 40 lines diff**, revised
   upward from initial ≤30 estimate after RPI5 cross-review caught two
   missed FK reference sites):
   - `src/db/migrations/001-initial.ts`: rename `sessions` → `sessions_v2`,
     `idx_sessions_agent_group` → `idx_sessions_v2_agent_group`,
     `idx_sessions_lookup` → `idx_sessions_v2_lookup`.
   - **`src/db/migrations/001-initial.ts:101`** — update
     `pending_questions.session_id REFERENCES sessions(id)` →
     `REFERENCES sessions_v2(id)`.
   - **`src/db/migrations/module-approvals-pending-approvals.ts:25`** —
     update `session_id TEXT REFERENCES sessions(id)` →
     `REFERENCES sessions_v2(id)`.
   - `src/db/schema.ts`: same `sessions` rename **plus**
     line 122 `pending_questions.session_id REFERENCES sessions(id)` →
     `REFERENCES sessions_v2(id)`.
   - `src/db/sessions.ts`: update all 6 `INSERT/SELECT/UPDATE/DELETE` to
     reference `sessions_v2`.
   - `src/db/migrations/index.ts`: bump migration index if needed (this is
     a no-op for fresh DBs since `001-initial.ts` is already the first run;
     existing v2 deployments would need a `014-rename-sessions-v2` migration
     instead — but at this writing **no v2 deployment exists** (verified
     2026-04-30 by RPI5 grep + smoke against `~/.nanoclaw-v2/data/nanoclaw.db`
     showing v1 schema only; `initDb()` has zero callers in `src/index.ts`),
     so a direct rename in `001-initial.ts` is safe).
2. **Test patch**:
   - `src/db/sessions.test.ts` (if present) updates table refs.
   - Add a new `src/db/migrations/sessions-coexistence.test.ts` that
     creates v1 and v2 schemas in the same in-memory DB and asserts both
     CRUD paths work without interfering.
3. **No data migration** in B.7 itself. v1 sessions stay live in the
   `sessions` table; v2 sessions appear in `sessions_v2`. Cutover migration
   (later) can copy or discard. **Footnote on `pending_questions`**: any v1
   `pending_questions` rows alive at cutover dangle — they FK the v1
   `sessions` PK shape `(group_folder, provider)` which `sessions_v2` does
   not have. Strategy: **abandon in place**, drain naturally as v1
   dispatcher retires. The v1 `pending_questions` table is dropped by the
   same B.8+ cleanup migration that drops v1 `sessions`.
4. **Cleanup migration** (B.8 or later, after v1 dispatcher is removed):
   - `015-drop-sessions-v1.ts` (or whatever the next index is): drops the
     v1 `sessions` table.
   - Same PR removes `src/db.ts` and the rest of the v1 dispatcher (which
     by then has zero callers — see triage doc § "keep-fork until V2
     dispatcher cutover").

## Test requirements

- Coexistence test (described above).
- Round-trip test on `sessions_v2`: create / get / find / update / archive
  via `src/db/sessions.ts` API.
- Regression: v1 `db.test.ts` still passes unchanged (the rename does not
  touch v1 fork code).

## Risks and open questions

- **Q1**: Do any deployed v2-schema DBs already exist that would need a
  proper `ALTER TABLE ... RENAME TO sessions_v2` migration instead of a
  direct rename in `001-initial.ts`?
  - **A1 (best knowledge today)**: No. Search confirms `initDb()` has zero
    callers in `src/index.ts`, the `chore/2026-04-30-v2-mergeback` branch
    is the first time v2 schema reaches the fork, and that branch is not
    yet merged. If that changes, swap the strategy to `014-rename-sessions-v2`.
- **Q2**: Does `agent_groups.id` need to be backfillable from `group_folder`
  for cutover-time data sync?
  - **A2**: Out of scope for B.7; see the cutover migration design (B.8+).
- **Q3**: `agent_provider` lives on **both** `agent_groups` (`001-initial.ts:14`)
  and `sessions_v2` (this table). Which is canonical? Override semantics?
  - **A3**: Defer to B.8+ design. Upstream ships both columns, so the override
    pattern is the most likely intent (agent_group default; per-session override
    when the user switches model mid-conversation). B.7 implementation must not
    silently pick one — keep both columns in sync until B.8 picks the canonical
    field. Earlier v0 of this doc claimed `agent_groups` had no provider column;
    that was wrong — discovered during RPI5 cross-review of `16fff30`.

## Related work

- `docs/v2-merge-triage-2026-04-30.md` § "Post-merge follow-ups" — original
  finding.
- `src/db.ts` (v1 schema)
- `src/db/migrations/001-initial.ts`, `src/db/schema.ts`, `src/db/sessions.ts`
  (v2 schema and accessor module)
- The five "keep-fork until V2 cutover" files in the same triage doc — they
  retire on the same day as v1 `sessions` does.
