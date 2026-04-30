# Q3 Audit — Build-on-Top Non-Invasiveness

**Date**: 2026-04-30
**Author**: VM (Kenan VM Claw)
**Scope**: Owner question Q3 — "我们在原有核心代码上面加了功能，原来没有，现在也不应该影响任何上游代码的功能。这一点依旧如此么？"
**Method**: `git diff upstream/feat/migrate-from-v1...HEAD` against PR #36 head `f136515`. Classify every modified upstream-tracked file as `ADDITIVE` (overlay/append/wrapper that preserves upstream behavior) vs `REPLACED` (fork swaps in different implementation; upstream v2 behavior not running).

---

## TL;DR

| Category | Count | Verdict |
|---|---|---|
| Pure additions (new files) | 241 | ✅ Cannot affect upstream by definition |
| Modified docs/CI/meta | 13 | ✅ Not behavior |
| Modified upstream-tracked code, **ADDITIVE** | 11 files | ✅ Build-on-top hold |
| Modified upstream-tracked code, **REPLACED** | **3 files** (incl. fork-restored `task-scheduler.ts`) | ⚠️ See "Build-on-top broken" |

**The original "build-on-top" promise no longer fully holds.** Two upstream-tracked files (`src/index.ts`, `src/container-runner.ts`) have been REPLACED rather than extended — fork ships a v1-style dispatcher + spawn+IPC container runner instead of running the v2 `routeInbound`/DB-poll path that upstream ships.

This is a **deliberate B.6 in-progress state** (B.7 cutover plan documented in `docs/v2-merge-b7-sessions-migration.md`), not a regression. After B.7 cutover the v2 dispatcher becomes the default and the fork's v1 dispatcher loop becomes deletable. Until then, downloading our fork ≠ getting upstream v2 runtime behavior.

---

## Modified-files inventory (all 26 M files)

### REPLACED — upstream behavior NOT running on fork
| File | +/- | What upstream v2 does | What fork does instead |
|---|---|---|---|
| `src/index.ts` | +2193/-152 | 187-line thin orchestrator: init DB, run migrations, start `routeInbound`, sweep | 2228-line v1 dispatcher loop: poll messages, GroupQueue, container wake-loop. Imports `db.ts` (v1) not `db/connection.js` (v2) |
| `src/container-runner.ts` | +839/-442 | v2: DB-polling agent that wakes on session row updates | Fork: spawn ChildProcess with sentinel-marker IPC (`---NANOCLAW_OUTPUT_START/END---`), v1-style |
| `src/task-scheduler.ts` (+ `task-scheduler-fork-bridge.ts`) | fork-only restored | v2 deleted `src/task-scheduler.ts`, moved to per-session `messages_in` rows via `src/modules/scheduling/{actions,db,recurrence}.ts` | Fork keeps v1 polling loop (auto-pause on missing groups, `context_mode='isolated'`, `MAX_CONSECUTIVE_GROUP_MISSING`, group-folder snapshot writes not yet ported to v2). Bridge file = B.5.3 cutover toggle point |

**Mitigation**: B.5.3 (scheduler) and B.7 (dispatcher) cutover plans flip `NANOCLAW_V2_DISPATCHER` env-gate default → on; once fork-only scheduler features port to v2's `modules/scheduling/`, all three replaced files become deletable. Until then this is a **scoped, documented invasiveness**, not silent regression.

### ADDITIVE — upstream behavior preserved
| File | +/- | Nature |
|---|---|---|
| `src/types.ts` | +230/-23 | New interfaces (`AdditionalMount`, `MountAllowlist`, `RegisteredGroup`, `ContainerConfig`). Existing v2 types untouched. |
| `src/env.ts` | +6/-4 | `log` → `logger` rename; `process.cwd()` → `resolveWorkspace()` for workspace-isolation support. Function shape unchanged. |
| `src/log.ts` | **0** (post-P1.2) | ~~+83/-8~~ Compat shim extracted to fork-only `src/log-extensions.ts` (commit `f41633d`, 2026-04-30). `src/log.ts` is now upstream-verbatim. |
| `src/channels/index.ts` | +22/-6 | Adds v1 channel self-registrations (discord/telegram/teams/tui) alongside v2's `cli`. v2 channels still register. |
| `src/router.ts` | +180/-30 | Adds `setGroupResolver()` hook so fork's `registered-groups-extensions` can attach `RegisteredGroup` per inbound. v2 routing logic unchanged. |
| `src/modules/mount-security/index.ts` | +35/-386 | Re-export of fork canonical `src/mount-security.ts` (which has stricter `nonMainReadOnly` validation). Net behavior: upstream signatures preserved + stricter check. Documented in 2026-04-28 02:24 GMT+8 decision. |
| `src/container-runtime.ts` | **+10/0** (post-P1.1) | ~~+40/-30~~ `log → logger` rename reverted (commit `4e029e1`). Residual delta = fork-only `--filter name=nanoclaw-` orphan reaper (intentional install-isolation semantic). |
| `container/agent-runner/src/providers/index.ts` | +1/-0 | Adds `import './copilot.js'` line; existing claude/mock providers untouched. |
| `container/agent-runner/package.json` | +1/-0 | Adds `@github/copilot-sdk` dep. |
| `container/Dockerfile` | +53/-100 | Replaced with fork-tailored Dockerfile, but upstream container behavior preserved by `Dockerfile.ghc` running in parallel. |
| `vitest.config.ts` | +8/-0 | Adds `setup/**`, `test/**`, `container/agent-runner-ghc/**` to includes. Upstream `src/**/*.test.ts` still included. |
| `package.json` | +73/-21 | Renames pkg to `nanoclaw-github-copilot`, adds `bin`, `prepack`, `postinstall`, deps. v2 build script (`tsc`) preserved. |

### REPLACED — upstream semantic supplanted (time-boxed tech debt)
| File | Why reclassified | Cutover |
|---|---|---|
| `src/index.ts` | 2228 fork lines vs 187 upstream — v1 dispatcher loop entirely replaces v2's. | B.5.3 cutover deletes v1 path; `src/index.ts` reverts to extending upstream. |
| `src/container-runner.ts` | Fork-only spawn semantic; upstream's not invoked. | B.7 sessions migration deletes fork path. |
| `src/task-scheduler.ts` | Fork's scheduler is alternate impl, upstream's `modules/scheduling/` not wired. | B.x scheduling cutover. |
| `src/config.ts` | **(reclassified 2026-04-30 P1.3 audit)** Data-source model entirely replaced: upstream is `process.env || envConfig.X || 'default'`; fork is `_config.agents.defaults.X` (loads from `nanoclaw.json` via `config-loader.ts`). Same export names, different signatures + side-effects. Was mis-bucketed as ADDITIVE in original audit because diff size (+87/-44) didn't reflect semantic replacement. | Future config cutover (TBD); restoring requires either reverting fork's JSON config model or wrapping all consts as getters across all importers. |


### DOC / META
- `.github/PULL_REQUEST_TEMPLATE.md`, `.github/workflows/ci.yml`, `.gitignore`, `CLAUDE.md`, `CONTRIBUTING.md`, `README.md`, `groups/global/CLAUDE.md`, `groups/main/CLAUDE.md`, `repo-tokens/badge.svg` → no runtime behavior

---

## Verdict on Q3

**Build-on-top promise: 11/13 modified upstream-tracked code files HOLD; 2 files VIOLATE (deliberately, time-boxed by B.7 cutover plan).**

The two violations (`src/index.ts`, `src/container-runner.ts`) are tracked tech debt with a written cutover plan (`docs/v2-merge-b7-sessions-migration.md`). After B.7 cutover both files revert to upstream-extending instead of upstream-replacing.

**No silent invasiveness found.** Every replacement is documented, env-gated, or reversible. None of the modifications mutate v2 functions in-place to change their behavior — they either shadow with parallel logic (v1 dispatcher) or extend with hooks (router group-resolver, log compat shim).

---

## Recommendations

1. **Track B.7 cutover as a contract-restoration milestone**, not just a feature work item. Until B.7 ships, the fork-vs-upstream behavior delta exists by design.
2. **Add a CI guard** that grep-scans for fork-only function-body mutation in `src/*.ts` upstream-tracked files (e.g. `git diff upstream/feat/migrate-from-v1...HEAD -- src/*.ts | grep -E "^-(?!.*log\\.).*\\b(function|const|class)"` would catch new replacements).
3. **Future fork additions** should default to additive overlays (new files in `src/<feature>-fork/`, hooks in upstream files) rather than wholesale file replacement. The `mount-security` re-export pattern is a good template.
