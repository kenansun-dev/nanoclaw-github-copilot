# Scheduled Tasks Proposal — align with OpenClaw cron

Status: draft v2 (rpi5+VM Claw, 2026-05-03), needs owner sign-off.
Scope: nanoclaw fork's `scheduled_tasks` (mig 103) + `task_run_logs` (mig 104),
fork v1 polling loop in `src/task-scheduler.ts`, bridge in `src/task-scheduler-bridge.ts`.

## Real user pain (kenan's original complaint, framed by VM Claw)

Today nanoclaw uses the agent's **final assistant message** as the
user-visible task output. That means:

1. LLM wrap-up chatter ("已发送 ✅") leaks into the user's chat view.
2. Whether the task "says something" is decided by the LLM, not by the
   task config — non-deterministic.
3. User cannot declare "only deliver the news body, nothing else" when
   creating the task.

OpenClaw's fix is to **separate payload (what the agent does) from
delivery (how the user sees the result)**:

- `payload.kind: 'systemEvent' | 'agentTurn'`
- `delivery.mode: 'none' | 'announce' | 'webhook'` with `channel/to`
- The task body itself does **not** call messaging tools; the runtime
  performs delivery uniformly based on `mode`.

This is the bleeding-edge fix and lands first (Phase 0). Cron parity
(expressions, tz, catchup) is real but is a roadmap item, not the
blocker.

## Today (fork)

- Schema: `scheduled_tasks(id, group_folder, chat_jid, prompt,
  schedule_type, schedule_value, next_run, last_run, last_result, status,
  consecutive_group_missing, created_at, context_mode, script)`.
- `schedule_type` ∈ {`once`, `interval`} only — no cron expressions, no tz.
- Dispatcher: polls `next_run`, calls `runContainerAgent` directly (or v2
  hook → write `messages_in` row + wakeContainer).
- Delivery: implicit — agent reply goes back through the original chat.
  No `delivery.mode`, no webhook, no failure-alert separation.
- Run history: `task_run_logs` (id, task_id, run_at, duration_ms, status,
  result, error). Surfaced via `nanoclaw task info <id>`.

## OpenClaw cron (reference)

`src/cron/` provides:

- **Schedule kinds**: `at`, `every` (with `everyMs` + `anchorMs`), `cron`
  (with `expr` + `tz` + `staggerMs`). Cron eval cached via `croner`.
- **Payload kinds**: `systemEvent` (inject text into a session) vs
  `agentTurn` (run a one-shot agent in isolated/named session with model,
  thinking, timeout, tool allowlist, fallbacks).
- **Session targeting**: `main` | `isolated` | `current` | `session:<id>`,
  validated against payload kind.
- **Delivery**: `none` | `announce` (chat) | `webhook` (POST), with
  `failureDestination`, `bestEffort`, `failureAlert.{after,cooldownMs}`.
- **Operational guards**: stagger (`stagger.ts`), restart-catchup, session
  reaper, run-log persisted with `delivered_status`, normalized job identity.

## Gap (fork → OpenClaw parity, ranked by user value)

1. **No cron expressions / tz.** Today users can only ask "every 30 min"
   or "once at <ISO>". No "every weekday 09:00 Asia/Shanghai".
2. **No delivery abstraction.** All output dumps back to the source chat.
   No webhook, no announce-to-different-channel, no `none` (silent run).
3. **No payload kinds.** `prompt` is always agent-turn-ish. No
   `systemEvent` equivalent for "just inject text into the next live turn"
   or for tool-restricted runs.
4. **No failure alert / retry control.** A failing task spams the same
   chat every interval until it auto-pauses on
   `MAX_CONSECUTIVE_GROUP_MISSING`.
5. **No stagger.** Multiple top-of-hour tasks fire simultaneously and
   contend for the single agent-runner container.
6. **No restart catchup.** If host was down at `next_run`, current loop
   silently advances to next slot. OpenClaw fires the missed slot once.
7. **No session targeting.** Always isolated container; can't reuse a
   long-lived session for cheaper cumulative context.

## Proposal — four phases, additive, no v1 break

### Phase 0 — payload / delivery separation (1 PR, ships first)

Goal: stop LLM wrap-up from leaking into the user's chat view; make
output deterministic per task config.

- New migration **105** (Phase 0 only) adds:
  - `delivery_mode` TEXT DEFAULT 'announce' -- 'none'|'announce'|'webhook'
  - `delivery_target` TEXT NULL             -- chat_jid override or URL
  - `payload_kind` TEXT DEFAULT 'agentTurn' -- 'systemEvent'|'agentTurn'
  Phase A's cron/every columns land in mig **106** so Phase 0 ships
  independently.
- New MCP tool `task_output(text, format?)` exposed only inside
  scheduled-task runs:
  - Does **not** go through the LLM message stream / chat reply path.
  - Runtime captures calls, builds the delivery envelope, and routes
    according to `delivery_mode`. Multiple calls concatenate in order.
  - `format` ('text' | 'markdown' | 'json') controls envelope rendering.
- Agent prompt for scheduled tasks is hardened (system-level):
  - Explicitly forbids "narrating progress" or sending confirmation
    messages via the regular chat reply tool.
  - Only `task_output` is allowed to produce user-visible output.
  - Rationale: fixing only the final assistant message still leaks
    mid-task tool-call narration into `announce` mode.
- Dispatcher (`runTask`) honours `delivery_mode`:
  - `announce` (default): runtime forwards the `task_output` envelope
    to chat. Final assistant message is **never** auto-forwarded.
  - `webhook`: POST envelope + run-log JSON to `delivery_target`.
  - `none`: drop output entirely; still write `task_run_logs`.
- CLI: `nanoclaw task add --delivery none|announce|webhook [--to <target>]`.
- Backfill: existing rows default to `announce`. The new prompt-hardening
  applies to all task runs immediately, so legacy tasks also stop
  narrating.

### Phase A — cron parser + schema rest (1 PR, mig 106)

- New migration 106: add cron/every columns to `scheduled_tasks`
  (delivery columns already landed in mig 105 via Phase 0):
  - `schedule_kind` TEXT  -- 'at' | 'every' | 'cron' (default 'once'→'at')
  - `cron_expr` TEXT NULL
  - `cron_tz` TEXT NULL
  - `every_ms` INTEGER NULL
  - `anchor_ms` INTEGER NULL
  - `stagger_ms` INTEGER DEFAULT 0
  - `failure_after` INTEGER DEFAULT 3
  - `failure_cooldown_ms` INTEGER DEFAULT 3600000  -- only honoured when delivery_mode='announce'; webhook always retries (caller dedupes), none never delivers
- Backfill: rows with old `schedule_type` keep working
  (`once`→`at`, `interval`→`every` + `every_ms`). No row rewrite required;
  `task-scheduler.ts` reads new columns when present, falls back to
  legacy when null.
- Add `src/scheduling/parse.ts` mirroring OpenClaw's `cron/parse.ts` +
  `cron/schedule.ts` shape (croner). Pure module, unit-tested with
  OpenClaw's edge cases (DST, timezone strings, malformed cron).
- CLI: extend `nanoclaw task add` with `--cron <expr> --tz <iana>`,
  `--every <duration>`, `--at <iso>`, `--stagger <ms>`.

### Phase B — dispatcher + delivery (1 PR)

- `task-scheduler.ts` switches on `schedule_kind` for `computeNextRun`.
- `runTask` consults `delivery_mode`:
  - `announce` (default): existing behaviour (chat reply).
  - `webhook`: POST run-log JSON to `delivery_target`. Reuse OpenClaw's
    `cron/webhook-url.ts` validation surface (no SSRF to localhost
    unless explicitly allowed in nanoclaw config).
  - `none`: drop output, still write `task_run_logs` row.
- Failure isolation: count consecutive failures per task. Cooldown
  semantics depend on `delivery_mode`:
  - `announce`: alert (single chat message) after `failure_after`,
    suppress until `failure_cooldown_ms` elapses (avoid chat spam).
  - `webhook`: deliver every failure as-is; caller endpoint dedupes.
  - `none`: no alert (silent by user choice).
  Distinct from `consecutive_group_missing` (which already pauses).

### Phase C — restart catchup + stagger + session targeting (1 PR)

- On scheduler boot: scan `scheduled_tasks WHERE next_run < now AND
  status='active'`. Fire each at most once with a "catchup" run-log
  marker (so the chat sees "[catchup]" prefix). Mirrors OpenClaw
  `service.restart-catchup.test.ts` semantics.
- Apply `stagger_ms` jitter on `every` and `cron` reschedules.
- New column `session_target` TEXT: `'isolated'` (default, today) |
  `'session:<id>'` (reuse a named long-lived container session). v2
  scheduler-bridge already prepared the dispatch hook for this.

## Non-goals (deliberate)

- We are **not** porting OpenClaw's full job-identity normalization,
  webhook signing, or main-session systemEvent semantics. Nanoclaw has
  no "main session" concept.
- We are **not** breaking v1 schema. Phase A is additive only; rollback
  is `DROP` of new columns + restore migration table.
- We are **not** unifying with OpenClaw's `cron-tool` MCP/agent surface
  in this proposal — that is a follow-up once the storage parity lands.

## Open questions for VM Claw + owner

1. v2-merge interaction: Phase B's delivery routing — should it run on
   the bridge `SchedulerV2DispatchFn` path or stay v1-only until v2
   takes over? (Affects whether we touch
   `task-scheduler-bridge.ts` in Phase B or only Phase A.)
2. CLI surface: keep `nanoclaw task add --interval 30m` aliasing to
   `--every 30m` for back-compat? (recommend: yes, deprecate in 2 versions)
3. Webhook signing: borrow OpenClaw's HMAC scheme or skip for v1
   nanoclaw? (recommend: skip in Phase B, add behind config flag later)
