# Q2 audit — fork directory hygiene after V2 mergeback

**Author**: RPI5 Claw, 2026-04-30
**Scope**: kenansun Q2 — "v2 改了目录结构，但我们 v1 时代加的 fork-only code 都平铺在 `src/` 下，是不是要做整理？"

## TL;DR

**Yes, the fork's `src/` is meaningfully out of sync with V2's emerging convention**, and one file is a near-literal duplicate of an upstream module. Recommend a structural refactor PR (separate from PR #36, post-merge), not a blocker for #36.

- 112 `.ts` files in fork `src/` total
- **83 are fork-only** top-level files (74% of `src/`)
- 47 of those are `*.test.ts`, 36 are sources
- Upstream V2 uses `src/modules/<feature>/index.ts` (+ helpers) for non-core features (8 such modules already)
- Upstream V2 keeps only **subdirs** at level 1: `channels/`, `db/`, `modules/`, `providers/`. Everything else under `modules/`.
- **Fork has 1 confirmed duplicate**: `src/mount-security.ts` (10.7KB, fork-only) vs `src/modules/mount-security/index.ts` (10.3KB, upstream V2). Same docstring, same DEFAULT_BLOCKED_PATTERNS, only diff = relative imports + fork uses external `types.ts` interface vs inline.
- Other fork-only top-level files cluster naturally into themes that map cleanly onto the `modules/` convention.

## Evidence

### V2 convention (upstream)

Upstream V2 has only 4 sub-dirs under `src/`:

```
src/channels/    (channel adapters)
src/db/          (DB schema + migrations)
src/modules/     (8 feature modules, each with index.ts)
src/providers/   (LLM providers)
```

Modules in `src/modules/`:

```
agent-to-agent/   approvals/   interactive/   mount-security/
permissions/      scheduling/  self-mod/      typing/
```

Each module: `index.ts` (entry) + helpers + tests + optional `db/` + optional `agent.md`/`project.md` markdown context files.

### Fork's `src/` shape

Fork has the same 4 upstream subdirs PLUS 2 fork-only subdirs (good — already following convention):

- `src/cli/` (20 files: `addon.ts`, `auth.ts`, `channel.ts`, `init.ts`, `pair.ts`, `plugin.ts`, `service.ts`, `task.ts`, `teams-manifest.ts`, `tui.ts`, `tunnel.ts`, `update.ts`, …)
- `src/memory/` (`cron.ts` + test)

But **83 top-level `src/*.ts` files are fork-only** and have no `modules/<X>/` home. Theme breakdown:

| Theme | File count | Examples |
|---|---|---|
| ipc / messaging | 11 | `ipc.ts`, `chat-manager.ts`, `chat-reconcile.ts`, `sender-allowlist.ts`, `shadow-inbound.ts` |
| registries | 12 | `abort-handler-registry.ts`, `access-gate-registry.ts`, `admin-command-registry.ts`, `slash-command-registry.ts`, `slash-commands.ts` |
| session / routing | 8 | `session-overrides.ts`, `session-routing.ts`, `session-cleanup.ts`, `router.group-resolver.test.ts` |
| config / loader | 6 | `config-extensions.ts`, `config-loader.ts`, `workspace-config.ts` |
| scheduling / task | 6 | `task-scheduler.ts`, `task-scheduler-fork-bridge.ts`, `group-queue.ts` |
| audit / doctor | 5 | `audit.ts`, `doctor.ts`, `env-doctor.test.ts` |
| remote / mcp | 4 | `remote-control.ts`, `mcp-auth.ts`, `mcp-azure-auth.ts`, `mcporter-integration.ts` |
| ghc / github | 3 | `ghc-session-recovery.test.ts`, `github-token-provider.ts` |
| host | 1 | `host-runner.ts` |
| (other) | ~25 | misc utils + many test files for upstream files (`index-*.test.ts`, `formatting.test.ts`, etc.) |

### Confirmed near-duplicate

`src/mount-security.ts` (fork, 10716 bytes) vs `src/modules/mount-security/index.ts` (upstream V2, 10259 bytes). Same docstring header, same default blocked patterns list, same allowlist-load logic. Only differences:

- Fork imports `MOUNT_ALLOWLIST_PATH` from `'./config.js'`; upstream from `'../../config.js'`
- Fork imports types from `./types.js`; upstream defines them inline
- Fork imports `logger` from `'./log.js'`; upstream `log` from `'../../log.js'`

This is almost certainly the result of fork adding `mount-security.ts` first, then upstream adopting it as `modules/mount-security/`. Either side likely studied the other.

### Other potentially-affected files

`src/modules/typing/index.ts` exists upstream; fork has `src/dispatcher-typing-bounded.test.ts` + `src/dispatcher-typing-rearm.test.ts` which test `index.ts` (upstream), not fork code. These aren't dupes — they're regression tests for upstream behavior — but they should likely live next to `src/modules/typing/` per the V2 convention.

## Recommendation

**Don't block PR #36.** This is hygiene, not correctness. Open a follow-up restructure PR after #36 merges. Suggested target shape:

```
src/
  channels/      (existing)
  cli/           (existing — already correct)
  db/            (existing)
  memory/        (existing — already correct)
  modules/       (existing + new fork modules — see below)
  providers/     (existing)
  index.ts, router.ts, config.ts, etc. (core entries — keep at root)
```

New `src/modules/` entries to create (each with `index.ts` + colocated `.test.ts`):

| New module | Pulls in |
|---|---|
| `modules/ipc/` | `ipc.ts`, `ipc-helpers.test.ts`, `ipc-plugin.test.ts`, `chat-manager.ts`, `chat-reconcile.ts`, `shadow-inbound.ts`, `sender-allowlist.ts` |
| `modules/registries/` | `abort-handler-registry.ts`, `access-gate-registry.ts`, `admin-command-registry.ts`, `slash-command-registry.ts`, `slash-commands.ts`, `slash-plugin.test.ts` |
| `modules/scheduling-fork/` | `task-scheduler.ts`, `task-scheduler-fork-bridge.ts`, `group-queue.ts` (or merge into upstream `modules/scheduling/`?) |
| `modules/audit/` | `audit.ts` + test |
| `modules/doctor/` | `doctor.ts`, `env-doctor.test.ts` |
| `modules/remote-control/` | `remote-control.ts` + test |
| `modules/mcp-auth/` | `mcp-auth.ts`, `mcp-azure-auth.ts`, `mcporter-integration.ts` |
| `modules/ghc/` | `ghc-session-recovery.test.ts`, `github-token-provider.ts` + test |
| `modules/session-overrides/` | `session-overrides.ts` + test |
| `modules/workspace-config/` | `config-extensions.ts`, `config-loader.ts`, `workspace-config.ts`, `workspace.ts` (these are fork's plugin/config layer that lets v1 dispatcher load fork-extensions) |

**Special case: `mount-security`**. Resolve duplicate by deleting `src/mount-security.ts` and pointing fork callers at `src/modules/mount-security/index.ts` (upstream's). Fork-only diffs (relative imports, types extraction) are trivial to port. ~30-min cleanup.

Files to **keep at `src/` root** (core entries, follow upstream convention):

- `index.ts`, `router.ts`, `config.ts`, `db.ts`, `delivery.ts`, `host-runner.ts`, `cli.ts`, `daemon-signal.ts`, `log.ts`, `logger.ts` (TBD: merge with upstream's `log.ts` or keep both?), `text-format.ts` (utility)

## Cost estimate

- Restructure PR: ~3-4 hours total work, mostly mechanical `git mv` + import path fixes. ~36 source files moved, ~47 test files moved with them, ~200 import-path edits. Vitest + tsc will catch leftover refs.
- `mount-security` dedup: ~30 min standalone (could be its own micro-PR).
- Risk: low — purely structural, behavior unchanged.
- Benefit: future upstream merges that touch `src/modules/` will conflict-resolve cleanly with fork modules of same shape; new contributors find fork features by feature name not by remembering "this lives at root because v1 was flat".

## Open question for owner

Is `modules/scheduling-fork/` a real second module or should `task-scheduler.ts` etc. move INTO upstream's existing `src/modules/scheduling/`? Depends on whether fork's task scheduling is "build on top of upstream scheduling" (= merge into the same dir, namespace via filenames) or "alternate scheduler that doesn't compose" (= separate module). VM Q3 audit on upstream non-regression should answer this.
