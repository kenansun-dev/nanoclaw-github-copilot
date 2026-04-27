# v2 Migration — Fork Feature Inventory

**Branch**: `v2-merge`
**Author**: Kenan Rpi5 Claw
**Date**: 2026-04-27
**Status**: Phase A.1 — decision matrix for upcoming Phase B/C work
**Scope**: every fork-only / fork-modified file vs upstream v2 (`upstream/main`), with port plan + owner assignment

---

## Decision matrix legend

- **status** — `add` (fork-only file, copy as-is) / `port` (rewrite to v2 architecture) / `replace` (v2 has equivalent, drop fork) / `merge` (combine fork + v2 logic) / `drop` (no longer needed)
- **risk** — 🟢 low (mechanical) / 🟡 medium (logic conflict) / 🔴 high (architecture incompatible, needs design)
- **effort** — AI hours estimate (rpi5/VM)
- **owner** — Phase B/C owner from synced plan

---

## Core fork features that MUST NOT regress (kenan principle 3)

| Feature | Files | v2 location | status | risk | owner |
|---|---|---|---|---|---|
| **GHC provider** | `container/agent-runner-ghc/`, `container/Dockerfile.ghc`, `container/entrypoint-ghc.sh`, `src/github-token-provider.ts` | new `src/providers/ghc.ts` + adapt to v2 Bun runner + Vault | port | 🔴 | VM (B.2) |
| **Host mode** | `src/host-runner.ts`, `src/container-runner.ts` (host-mode branch), `src/container-runtime.ts` | merge into v2 `src/container-runner.ts` (already has lifecycle hook) | port | 🔴 | rpi5 (B.3) |
| **Discord channel** | `src/channels/discord.ts`, `src/channels/registry.ts` (discord entry) | implement v2 `adapter.ts` interface; keep file in `src/channels/discord.ts` | port | 🟡 | rpi5 (B.4) |
| **Telegram channel** | `src/channels/telegram.ts` | same pattern → adapter | port | 🟡 | rpi5 (B.4) |
| **Teams channel + streaming** | `src/channels/teams.ts`, `src/channels/teams-streaming.ts` (+ today's listen-race fix) | same pattern → adapter | port | 🟡 | rpi5 (B.4) |
| **TUI channel** | `src/channels/tui.ts` | same pattern → adapter | port | 🟡 | rpi5 (B.4) |
| **Config system** (`config-loader.ts`, `config.ts`, `config-extensions.ts`) | `src/config*.ts` | extend v2 `src/config.ts` + keep `config-extensions.ts` overlay; drive `enabledModules` | merge | 🟡 | VM (B.5) |

## Fork-only modules (write as v2 modules, registration via enabledModules)

| Feature | Files | v2 path | status | risk | owner |
|---|---|---|---|---|---|
| **Sender allowlist** (replace v2 `modules/permissions`) | `src/sender-allowlist.ts` | new `src/modules/sender-allowlist/` | port | 🟡 | VM (B.5) |
| **Scheduled tasks** (CLI + auto-pause + context_mode='isolated', replace v2 `modules/scheduling`) | `src/task-scheduler.ts`, `src/cli/task.ts`, `src/db.ts` (scheduled_tasks/task_run_logs tables), `src/memory/cron.ts` | new `src/modules/scheduling-fork/` | port | 🟡 | rpi5 (B.1 schema) |
| **Audit** | `src/audit.ts` | new `src/modules/audit/` | port | 🟢 | rpi5 (Phase B.4 副 task) |
| **Chat manager / chat reconcile** | `src/chat-manager.ts`, `src/chat-reconcile.ts` | new `src/modules/chat-manager/` | port | 🟡 | rpi5 (B.4 副 task) |
| **Session overrides / routing** | `src/session-overrides.ts`, `src/session-routing.ts` | merge into v2 `src/db/sessions.ts` extension | merge | 🟡 | VM (B.5) |
| **Group queue** (serialize chat) | `src/group-queue.ts` | likely **drop** — v2 two-DB single-writer makes this redundant | drop? | 🟡 | TBD verify; rpi5 |
| **Streaming (flash edit coalescer)** | `src/flash-edit-coalescer.ts` | new `src/modules/streaming/` | port | 🟢 | rpi5 (C.1) |
| **Typing pulse (bounded)** | `src/dispatcher-typing-bounded.ts` (today) + `dispatcher-typing-rearm.ts` | merge into v2 `src/modules/typing/` (extend default) | merge | 🟡 | rpi5 (B.4) |
| **Abort triggers** | `src/abort-triggers.ts` | new `src/modules/abort/` | port | 🟢 | VM (C.2) |
| **Mount security (extension)** | `src/mount-security.ts` | merge with v2 `src/modules/mount-security/` (mostly identical) | merge | 🟢 | VM (B.5) |
| **MCP auth helpers** | `src/mcp-auth.ts`, `src/mcp-azure-auth.ts`, `src/mcporter-integration.ts` | new `src/modules/mcp-auth/` | port | 🟢 | VM (C.2) |
| **IPC plugin / auth** | `src/ipc.ts`, `src/ipc-auth.ts`, `src/ipc-helpers.ts`, `src/ipc-plugin.ts` | new `src/modules/ipc/` (or keep in core if v2 needs) | port | 🟡 | VM (C.2) |
| **Remote control** | `src/remote-control.ts` | new `src/modules/remote-control/` | port | 🟢 | VM (C.2) |

## CLI / TUI / slash / packaging (Phase C.1)

| Feature | Files | v2 path | status | risk | owner |
|---|---|---|---|---|---|
| Top-level CLI | `src/cli.ts` + `src/cli/*.ts` (addon, auth, channel, config-set, init, loglevel, pair, plugin, reload, service, task, teams-manifest, tui, tui-direct, tunnel, update) | keep `src/cli/` folder, refactor to consume v2 db API | port | 🟡 | rpi5 (C.1) |
| Slash commands | `src/slash-commands.ts`, `src/slash-plugin.ts` | new `src/modules/slash/` | port | 🟡 | rpi5 (C.1) |
| Daemon signal | `src/daemon-signal.ts` | keep in core | port | 🟢 | rpi5 |
| Doctor | `src/doctor.ts` | keep | port | 🟢 | rpi5 |
| Env doctor | `src/env.ts` (fork extras) | merge with v2 `src/env.ts` | merge | 🟢 | VM (B.5) |
| Logger | `src/logger.ts` | replace with v2 `src/log.ts`? OR keep fork (logger.ts has structured fields v2 lacks) | merge | 🟡 | VM (C.2) |
| Workspace | `src/workspace.ts` | keep | add | 🟢 | rpi5 |
| Timezone | `src/timezone.ts` | keep | add | 🟢 | rpi5 |
| Group folder | `src/group-folder.ts` | merge with v2 group-init | merge | 🟢 | VM |

## Fork DB tables (Phase B.1)

write as v2 migrations under `src/db/migrations/100..104-fork-*.ts`:

| Table | Source | New migration |
|---|---|---|
| `chats` | fork | `100-fork-chats.ts` |
| `sender_allowlist` | fork | `101-fork-sender-allowlist.ts` (or scope into sender-allowlist module migration) |
| `registered_groups` | fork | `102-fork-registered-groups.ts` |
| `scheduled_tasks` | fork | `103-fork-scheduled-tasks.ts` (in scheduling-fork module) |
| `task_run_logs` | fork | `104-fork-task-run-logs.ts` (in scheduling-fork module) |

## v2 modules — adoption decisions

| v2 module | Decision | Reason |
|---|---|---|
| `modules/typing` | ✅ adopt + merge fork bounded pulse | helpful default, fork extends |
| `modules/mount-security` | ✅ adopt | fork has near-identical impl |
| `modules/interactive` (ask_user_question) | ✅ adopt | useful capability for agent harness |
| `modules/scheduling` | ✅ ADOPT (alongside fork `scheduling-fork/`) | kenan 23:20 reversal: take all v2. Fork CLI/auto-pause/context_mode stay in `scheduling-fork/`; v2 module exposed for users wanting series_id/cron-style |
| `modules/permissions` (4-tier) | ✅ ADOPT (alongside fork `sender-allowlist/`) | kenan 23:20 reversal. v2 4-tier (user/role/agent_group/dm) coexists; fork allowlist is simpler entry-point opt-in |
| `modules/approvals` | ✅ ADOPT | kenan 23:20: "all v2 features". If breaks fork design, adapt later |
| `modules/self-mod` | ✅ ADOPT | kenan 23:20 reversal. May conflict with "no skill dynamic code change" — surface during B/C wire-up |
| `modules/agent-to-agent` | ✅ ADOPT | kenan 23:20 reversal. Brings destinations + agent_destinations table |

## v2 architecture features — adoption decisions

| v2 feature | Decision | Reason |
|---|---|---|
| Two-DB session split (inbound/outbound) | ✅ adopt | solves cross-mount lock contention; resolves group-queue serialize root cause |
| Central DB (`data/v2.db`) for entities | ✅ adopt | clean entity separation |
| Migration system (`src/db/migrations/001..013` + module migrations) | ✅ adopt | fork's inline `createSchema` is debt |
| `host-sweep.ts` tick | ✅ adopt | needed for v2 message flow + scheduling-fork can hook in |
| `chat-sdk-bridge` + `channel-registry` adapter pattern | ✅ adopt (channels stay in main repo, implement adapter interface) | clean channel boundary |
| `delivery.ts` + `registerDeliveryAction` | ✅ adopt | clean module hook surface |
| `response-registry.ts` | ✅ adopt | needed for module hooks |
| Bun container runtime | 🟡 evaluate | currently Node; Bun may break GHC runner; defer to B.2 owner |
| OneCLI Vault | 🟡 evaluate | secure but may break GHC token flow; defer to B.2 owner |
| Three-level isolation (per-channel / shared agent / shared session) | ✅ adopt as opt-in | matches OC dmScope; default keep current behavior to avoid migration of existing chats |
| `destinations` + named addressing | ✅ adopt | clean cross-channel routing |
| `agent_destinations` | ✅ adopt as part of channels port | needed for Phase B.4 |
| `pending_questions` | ✅ adopt with interactive module | comes for free |
| Migration `.heartbeat` mtime touch | ✅ adopt | fits existing fork heartbeat pattern |
| `seq` parity invariant (host even / container odd) | ✅ adopt | mechanical, no fork conflict |

## Phase plan recap

| Phase | Owner | Deliverable | Status |
|---|---|---|---|
| **A.0** | VM | `npm test` baseline 957/957 on `v2-merge` | pending |
| **A.0** | rpi5 | `npm test` baseline (parallel verify) | running |
| **A.1** | rpi5 | this inventory document | ✅ done |
| **A.2** | VM | lift v2 files (`src/db/`, `src/modules/{interactive,mount-security,typing}/`, `src/channels/{adapter,channel-registry,chat-sdk-bridge,ask-question}.ts`, `src/{host-sweep,delivery,response-registry,session-manager,group-init,platform-id,install-slug,claude-md-compose,command-gate,container-config}.ts`, `src/providers/`, container/agent-runner v2 layer) into `_v2/` staging then move into place after rpi5 review | pending |
| **B.1** | rpi5 | fork migrations 100..104 + scheduling-fork module skeleton + sender-allowlist module skeleton | pending |
| **B.2** | VM | GHC provider port to v2 + verify Bun-vs-Node + Vault feasibility | pending |
| **B.3** | rpi5 | host mode port | pending |
| **B.4** | rpi5 | 5 channels port to adapter (Discord/Telegram/Teams/Teams-streaming/TUI) | pending |
| **B.5** | VM | config system + enabledModules + config-extensions overlay | pending |
| **C.1** | rpi5 | CLI/TUI/slash/streaming/packaging port | pending |
| **C.2** | VM | plugin/remote-mcp/selfaware skill/IPC/abort/MCP auth port | pending |
| **D** | both | full test suite + 5-channel smoke | pending |

## Open questions for kenan (collect, ask only after Phase A done)

1. Three-level isolation default behavior — keep current chat=session (opt-in new isolation) or default to v2 shared-agent semantics?
2. Bun vs Node container runtime — do we adopt v2 Bun (faster cold start) or keep Node (GHC runner risk)?
3. OneCLI Vault — adopt (security++) or skip (operational simplicity)?
4. After v2-merge done, do we keep `modules/scheduling` as opt-in for users who want v2's series_id model?

## Coordination conventions

- All Phase B/C sub-branches: `v2-merge/phase-X.Y-<short-name>` targeting `v2-merge`
- PR review: cross-review only (rpi5 reviews VM's, VM reviews rpi5's), no self-merge
- Commit format: `phase B.X: <one-liner>` for traceability
- `v2-merge` itself does NOT open PR to `main` until Phase D done + kenan approval

---

## 2026-04-27 23:20 — kenan policy reversal

> "这次尝试里面，所有的 upstream v2 feature 我都要，如果 break 了我们的设计，我们看怎么再去改去适配。所以不需要问我了"

**Effect**: every ❌ in the v2-modules table above flips to ✅ ADOPT. Fork
features (sender-allowlist, scheduling-fork) become **add-ons stacked on
top of the v2 modules** rather than replacements.

The 3 open questions (three-level isolation default, Bun vs Node, OneCLI
Vault) are no longer questions — adopt all, adapt as needed during B/C.

**Implication for B.5 router merge**: v2 router hooks
(`setSenderResolver`, `setAccessGate`, `setSenderScopeGate`,
`setChannelRequestGate`, `routeInbound`) must be wired into fork
`router.ts` (currently v1 formatter). 22 baseline test failures are
pinned to this work.

---

## Phase B.1 — fork migrations 100..104 (rpi5)

**Commit on `v2-merge-b1-fork-migrations`** (sub-branch off `ff5cf4a`).

Added 5 fork-only migrations under `src/db/migrations/` (numbered 100+
to leave 014..099 reserved for upstream):

| # | name | tables | notes |
|---|---|---|---|
| 100 | `100-fork-chats` | `chats`, `messages` | message archive for audit/chat-manager |
| 101 | `101-fork-sender-allowlist` | `sender_allowlist` | stub schema; B.4 module port populates |
| 102 | `102-fork-registered-groups` | `registered_groups` | fork's pre-v2 group binding model |
| 103 | `103-fork-scheduled-tasks` | `scheduled_tasks` | folds in all 3 ALTER columns from `src/db.ts` (context_mode, script, consecutive_group_missing) |
| 104 | `104-fork-task-run-logs` | `task_run_logs` | per-run history powering `nanoclaw task info` |

Registered in `src/db/migrations/index.ts` after migration013. Tests:
22 fail / 1050 pass / 8 skip — **same as pre-B.1 baseline**, no
regression introduced. tsc clean on new files.

## Phase B.5 — schedule schema decision (rpi5 + VM, locked 00:30)

**Hybrid v2 messages_in (firing driver) + fork scheduled_tasks (lifecycle state).**

Fork's existing `scheduled_tasks` (migration 103) and `task_run_logs`
(migration 104) get **rewritten in B.5** — the column set bakes in
lessons from cross-review with VM:

```sql
-- migration 103 (B.5 rewrite)
CREATE TABLE scheduled_tasks (
  series_id TEXT PRIMARY KEY,           -- soft ref → messages_in.series_id
                                        -- (not a real FK: messages_in.series_id is
                                        --  not UNIQUE there; multiple fired rows share
                                        --  one series_id. Sync via scheduling/actions.ts.)
  group_folder TEXT NOT NULL,
  context_mode TEXT NOT NULL DEFAULT 'isolated',
  script TEXT,                           -- pre-agent gate script (fork-only)
  state TEXT NOT NULL DEFAULT 'active',  -- active | paused | disabled
  last_run TEXT,
  last_result TEXT,
  consecutive_group_missing INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_scheduled_tasks_state ON scheduled_tasks(state);

-- migration 104 (B.5 rewrite)
CREATE TABLE task_run_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  series_id TEXT NOT NULL REFERENCES scheduled_tasks(series_id) ON DELETE CASCADE,
  ran_at TEXT NOT NULL DEFAULT (datetime('now')),
  result TEXT,
  duration_ms INTEGER
);
CREATE INDEX idx_task_run_logs_series ON task_run_logs(series_id);
```

Rationale (kenan q3 audit + VM cross-review):
- v2 `messages_in.recurrence` + `process_after` IS the firing driver.
  Fork loses its own cron tick loop; `scheduling/actions.ts` insertTask /
  cancel / pause / update become the entry points.
- v2 has no analog for fork-only lifecycle state
  (`last_run` / `last_result` / `consecutive_group_missing` auto-pause /
  `script` pre-agent gate / `context_mode='isolated'`). These stay in
  `scheduled_tasks` — the table is now a *task lifecycle table*, not a
  schedule table.
- `task_run_logs` keeps per-run audit history; v2 has no equivalent.
- OpenClaw uses `config/cron/jobs.json` (no SQL at all), proving the
  schema design is open. We pick SQL hybrid over JSON for parity with
  fork's existing `nanoclaw task` CLI surface.
- Cron-string ↔ ISO recurrence converter goes in a dedicated
  `src/scheduling-fork-bridge.ts` (B.5 work) so `task-scheduler.ts`
  rewrite stays minimal.

Fork's task-scheduler.ts at B.5: `schedule_*` writes go via
`actions.insertTask(series_id, recurrence, processAfter, ...)`;
lifecycle updates go straight into `scheduled_tasks`. `nanoclaw task list`
reads `scheduled_tasks` (state column), joined to `messages_in` for
next-fire timestamp via `series_id`.

Migrations 103/104 are rewritten **in place** at B.5 (v2-merge has no
production consumer, fresh-DB-only migration path).

## Phase B.1 deferred items

**Not touched** (deferred to later phases to avoid VM conflict):
- `src/db.ts` `createSchema()` still creates the same 5 tables inline
  (`CREATE TABLE IF NOT EXISTS`). v2 migrations also create them — no
  conflict because both use IF NOT EXISTS + identical column lists.
  B.5 will remove inline `createSchema` and rely on migrations only.
- sender-allowlist module skeleton — defer to B.4 alongside channel
  ports so the module's runtime entry-point lands in one commit.
- scheduling-fork module skeleton — defer to B.4 (paired with
  `nanoclaw task` CLI, both touch `scheduled_tasks`).

## Phase B.5-prep: dispatcher cut-list

> Inventory of every place v1 dispatcher in `src/index.ts` calls into
> a fork module today, with the v2 hook that should replace each call
> when router merge happens. Generated 2026-04-28 from `bf69390`.
> Numbers are line numbers in `src/index.ts` (2130 lines total).

### Imports from fork modules (top of file)

| line | import                                                                 | fork module                | v2 replacement                                           | B.5 action                                                                                  |
| ---- | ---------------------------------------------------------------------- | -------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 46   | `getAllRegisteredGroups`                                               | `./db.js`                  | `modules/registered-groups-fork`                         | flip import path → re-export shim                                                           |
| 54   | `getRegisteredGroup`                                                   | `./db.js`                  | `modules/registered-groups-fork`                         | flip import path                                                                            |
| 57   | `setRegisteredGroup`                                                   | `./db.js`                  | `modules/registered-groups-fork`                         | flip import path                                                                            |
| 64   | `isAbortRequestText`                                                   | `./abort-triggers.js`      | `modules/abort-fork`                                     | flip import path                                                                            |
| 66   | `startIpcWatcher`                                                      | `./ipc.js`                 | `modules/ipc-fork`                                       | flip import path                                                                            |
| 73-77 | `restoreRemoteControl, startRemoteControl, stopRemoteControl`         | `./remote-control.js`      | **stays in fork** (5 dispatcher callers; no v2 equiv)    | router exposes `registerAdminCommand('/remote-control', ...)`; index.ts moves into hook     |
| 79-83 | `isSenderAllowed, isTriggerAllowed, loadSenderAllowlist, shouldDropMessage` | `./sender-allowlist.js` | `modules/sender-allowlist-fork`                          | flip import path; later wire into `registerAccessGate(...)` on router                       |
| 85   | `startSchedulerLoop`                                                   | `./task-scheduler.js`      | hybrid (B.5 prep doc — schedule schema lock above)       | rewrite scheduler to use v2 `messages_in` driver + fork `scheduled_tasks` lifecycle table   |

### Dispatcher call sites that gate inbound (B.5 router replaces)

| line       | what it does                                                                                                                  | v2 hook                                                                            | notes                                                                                  |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 135        | `registeredGroups = getAllRegisteredGroups()` — startup load                                                                  | `router.startup({ groupResolver })`                                                | `groupResolver` provided by `registered-groups-fork`                                   |
| 282        | `setRegisteredGroup(jid, group)` — channel metadata callback writes group on first observed chat                              | `router.onChatMetadata(...)` calls `registerGroupResolver`                         | currently happens inside `onChatMetadata` lambda                                       |
| 369-381    | `import('./slash-commands.js'); handleSlashCommand(slashInput, slashCtx)` — slash command resolution path 1                   | `router.processSlashCommand(...)`                                                  | router needs a slash registry; current fork has unified `slash-commands.ts` (hot path) |
| 399        | `loadSenderAllowlist()` (startup metadata gate)                                                                               | `registerAccessGate({ sender-allowlist-fork.isSenderAllowed })`                    | one of two call sites; both go through the same v2 gate                                |
| 1271       | `loadSenderAllowlist()` (per-message gate)                                                                                    | `registerAccessGate(...)`                                                          | same as above                                                                          |
| 1294-1295  | second `import('./slash-commands.js'); handleSlashCommand(...)` — slash command resolution path 2 (live message handler)      | `router.processSlashCommand(...)`                                                  | merge with line 369 path                                                               |
| 1688       | `registeredGroups = getAllRegisteredGroups()` — refresh on dispatcher loop tick                                               | `router.refreshGroups()` calling fork resolver                                     | router decides cadence                                                                 |
| 1788-1832  | `/remote-control` and `/remote-control-end` admin command handler (`handleRemoteControl(...)`)                                | `registerAdminCommand('/remote-control', handler)` on router                       | handler stays in `remote-control.ts`; router just forwards                             |
| 1841-1857  | fast-abort: `isAbortRequestText(msg.content)` short-circuit before dispatch                                                   | `registerAbortHandler({ matcher, onAbort })` on router                             | `matcher` from `abort-fork`; router enforces ordering before LLM call                  |
| 1860       | `getAllRegisteredGroups()` after fast-abort to refresh map                                                                    | `router.refreshGroups()`                                                           | same as 1688                                                                           |
| 1888-1891  | `loadSenderAllowlist()` then `isSenderAllowed(chatJid, msg.sender, cfg)` — per-message access gate                            | `registerAccessGate(...)`                                                          | router rejects/drops based on gate result                                              |
| 1974-1995  | `startSchedulerLoop({ registeredGroups, getSessions, queue, onProcess, sendMessage, editMessage })`                           | swap to v2 `scheduling/actions.ts` driver + bridge in `task-scheduler-fork-bridge` | per B.5 schedule schema lock above                                                     |
| 1996+      | `startIpcWatcher({ sendMessage, reactToMessage, sendFile, ... })`                                                             | router runs IPC watcher beside v2 message loop; both feed `messages_in`            | `ipc-fork` exposes `startIpcWatcher`; router supplies channel ops                      |

### v1 vs v2 path coexistence (during B.5 transition)

- v1 path: `src/channels/index.ts` self-registers fork channels via
  `./registry.ts` → `src/index.ts` dispatcher binds them.
- v2 path: `src/channels/adapters-barrel.ts` self-registers v2
  adapters via `./channel-registry.ts` → router binds them.
- **Single-line swap when B.5 is ready**: change the channel barrel
  import in `src/index.ts` (currently inside `connectChannels()`)
  from `import './channels/index.js'` to
  `import './channels/adapters-barrel.js'` and stop calling
  `registry.connect()` for the v1 list.

### What B.5 does NOT touch

- container internals (`container/` subtree) — covered by C-step3/4.
- `src/mcp-auth.ts` / `src/mcporter-integration.ts` — outbound MCP
  auth, called by agent-runner main, never hits dispatcher.
- `src/mount-security.ts` — called by container-runner, not
  dispatcher. (Re-exported by `modules/mount-security` for v2
  consumers; B.5 does not change call sites.)
- `src/command-gate.ts` — in-DB admin gate, called from
  v2 `messages_in` consumer (already on v2 path), not from
  `src/index.ts`.

### Open questions to flush before B.5 touches code

1. Slash commands: keep fork's hot-path `slash-commands.ts` (covers
   `/think`, `/model`, `/agent`, etc.) or fold into v2
   `router.processSlashCommand`? Fork file is large and changes
   often. Recommendation: keep fork file, expose via a single
   `registerSlashCommandHandler(...)` hook on router.
2. Scheduler: confirmed at B.5-prep — hybrid v2 driver + fork
   lifecycle table. Bridge file `task-scheduler-fork-bridge.ts` to
   be written at B.5 start.
3. `remote-control` lifecycle: when router restarts, do
   `restoreRemoteControl(...)` calls happen pre- or post-router-up?
   Pre, per fork order today (line 73 import, called at startup).

## Phase B.5-prep #2: dispatcher hook registries (design)

> **Re-frame**: v2 has no `router` class to merge into. `src/router.ts`
> is 83 lines of text formatters (escapeXml / formatMessages / findChannel).
> Real "routing" lives in `src/index.ts` (2130L dispatcher) plus three
> singleton registries that modules self-register against:
>
> - `src/response-registry.ts` — `registerResponseHandler(fn)` + `onShutdown(cb)`
> - `src/delivery.ts` — `onDeliveryAdapterReady(cb)` + `registerDeliveryAction(name, handler)`
> - `src/channels/channel-registry.ts` — `registerChannelAdapter(...)`
>
> B.5 doesn't merge a router — it adds **four more singleton registries**
> for the dispatcher gating points (access / abort / admin command / slash)
> and rewrites `src/index.ts` to consult them instead of inline-importing
> fork modules. Same pattern as approvals/scheduling/permissions modules
> already use.

### Proposed registries (new files in `src/`)

#### 1. `src/access-gate-registry.ts`

```ts
export type AccessGate = (
  chatJid: string,
  sender: string,
  content: string,
) => 'allow' | 'drop' | 'deny';

export function registerAccessGate(gate: AccessGate): void;
export function runAccessGates(...): 'allow' | 'drop' | 'deny';
```

- `sender-allowlist-fork` registers a gate at import time:
  `registerAccessGate((jid, sender) => isSenderAllowed(jid, sender, loadSenderAllowlist()) ? 'allow' : 'drop')`
- Dispatcher (replaces `src/index.ts` 1888-1891) calls
  `runAccessGates(...)` — first non-`allow` wins.

#### 2. `src/abort-handler-registry.ts`

```ts
export type AbortHandler = {
  matcher: (text: string) => boolean;
  onAbort: (chatJid: string, msg: NewMessage) => Promise<void>;
};

export function registerAbortHandler(h: AbortHandler): void;
export function checkAbort(content: string): AbortHandler | null;
```

- `abort-fork` registers `{ matcher: isAbortRequestText, onAbort: <inline ack send> }`.
- Dispatcher (replaces `src/index.ts` 1841-1857) calls
  `const h = checkAbort(content); if (h) { await h.onAbort(...); return; }`.

#### 3. `src/admin-command-registry.ts`

```ts
export type AdminCommand = {
  name: string;            // e.g. '/remote-control'
  aliases?: string[];      // e.g. ['/remote-control-end']
  handler: (chatJid: string, args: string, msg: NewMessage) => Promise<void>;
};

export function registerAdminCommand(cmd: AdminCommand): void;
export function lookupAdminCommand(text: string): AdminCommand | null;
```

- `remote-control.ts` registers two commands at import time. Handler is
  the existing `handleRemoteControl(...)` body, lifted out of `src/index.ts`.
- Dispatcher (replaces `src/index.ts` 1788-1832) becomes:
  `const cmd = lookupAdminCommand(trimmed); if (cmd) { await cmd.handler(...); return; }`.

#### 4. `src/slash-command-registry.ts`

```ts
export type SlashRouter = (
  input: string,
  ctx: SlashContext,
) => Promise<SlashResult>;

export function registerSlashRouter(router: SlashRouter): void;
export function getSlashRouter(): SlashRouter | null;
```

- Single-router slot (not a list). `slash-commands.ts` registers its
  `handleSlashCommand` at import time:
  `registerSlashRouter(handleSlashCommand)`.
- Dispatcher (replaces `src/index.ts` 369-381 + 1294-1295 inline imports)
  calls `getSlashRouter()?.(...)`.
- Why single-slot: fork's `slash-commands.ts` is the canonical registry
  (`COMMANDS` map); it doesn't compose with other slash routers. Adding
  list-of-routers later is straightforward if needed.

### Group resolver — already in `registered-groups-fork`, no new registry needed

`src/index.ts` 135 / 1688 / 1860 just call `getAllRegisteredGroups()`
imported from `./db.js`. After flip to `modules/registered-groups-fork`,
no registry indirection — module exports the function, dispatcher imports
it. Group resolver doesn't need a hook because there's only ever one
resolver (one DB).

### Scheduler — bridge file, not registry

Per B.5 schedule schema lock above: B.5 writes
`src/task-scheduler-fork-bridge.ts` that wraps fork's `task-scheduler.ts`
loop body to source firings from v2 `messages_in` (via
`modules/scheduling/actions.ts`) instead of inline `setTimeout` over
fork's `scheduled_tasks`. `src/index.ts` 1974-1995 then imports
`startSchedulerLoop` from the bridge, not the original.

### Side-effect import order (B.5 rewrites `src/index.ts` top)

```ts
// 1. Singleton registries (no side effects, just module init)
import './response-registry.js';
import './delivery.js';
import './access-gate-registry.js';        // NEW
import './abort-handler-registry.js';      // NEW
import './admin-command-registry.js';      // NEW
import './slash-command-registry.js';      // NEW

// 2. Channel adapters (self-register on v2 channel-registry)
import './channels/adapters-barrel.js';    // (was './channels/index.js' on v1)

// 3. Modules barrel (self-register on registries above)
import './modules/index.js';

// 4. Fork modules that need explicit import (no module-style self-register yet)
import './modules/sender-allowlist-fork/index.js';
import './modules/registered-groups-fork/index.js';
import './modules/abort-fork/index.js';
import './modules/ipc-fork/index.js';
import './modules/mcp-auth-fork/index.js';
import './modules/mount-security/index.js';
import './remote-control.js';              // self-registers admin commands
import './slash-commands.js';              // self-registers slash router
import './task-scheduler-fork-bridge.js';  // exports startSchedulerLoop
```

Net result: `src/index.ts` body shrinks from 2130L of inline branching
to a thin loop that calls `runAccessGates → checkAbort → lookupAdminCommand →
getSlashRouter → forward to LLM`. All gating logic lives in modules.

### Open design questions for B.5

1. **Access gate ordering**: registration order vs explicit priority?
   Recommendation: registration order, document it.
2. **Multi-slash-router**: keep single-slot or list-of-routers? Single
   today, list later is non-breaking.
3. **Should `command-gate.ts` (host-side classify-and-deny gate) move
   into `admin-command-registry`?** No — `command-gate` runs against
   already-routed-to-container messages from `messages_in`, different
   layer. Keep it in `src/command-gate.ts`, called by v2 message
   consumer.
4. **`abort-handler` ordering vs `access-gate` ordering**: dispatcher
   runs access gates FIRST (drop bad senders before they can abort),
   then abort, then admin command, then slash, then LLM. Documented
   in dispatcher comment when B.5 lands.

### Estimated B.5 work (AI time)

- 4 new registry files + tests: ~30 min
- Module self-registration edits (5 files): ~15 min
- `src/index.ts` rewrite to consult registries: ~45 min
- `task-scheduler-fork-bridge.ts` write + tests: ~30 min
- Migration 103/104 rewrite per schema lock: ~20 min
- Full suite + integration smoke: ~30 min
- **Total: ~3 hours AI time** assuming no surprise architecture pivot.

_Generated_ 2026-04-28 02:42 GMT+8.
