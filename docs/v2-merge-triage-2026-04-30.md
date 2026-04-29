# v2-merge ↔ upstream/feat/migrate-from-v1 Conflict Triage

Date: 2026-04-30
Base: v2-merge @ 17691e7 + upstream/feat/migrate-from-v1
Total content/add-add conflicts: 92
Total modify/delete (UD) conflicts: 23
Grand total: 115 unmerged paths

## Owner split

### VM (modules + container + top-level src)
src/modules/* (33), container/* (12), src/index.ts, src/router.ts,
src/types.ts, src/state-sqlite.ts, src/session-manager.ts,
src/router.ts, src/log.ts, src/env.ts, vitest.config.ts,
.gitignore, .github/workflows/ci.yml, README.md, CLAUDE.md,
package.json, repo-tokens/badge.svg

### RPI5 (db + channels + setup + group docs)
src/db/* (14 add/add), src/db.ts/db.test.ts/db-migration.test.ts (UD: keep our overlay or migrate to upstream layout — needs design decision),
src/channels/* (9 incl. UD registry.ts/.test.ts), src/webhook-server.ts,
setup/auto.ts, setup/onecli.ts, setup/verify.ts,
groups/global/CLAUDE.md, groups/main/CLAUDE.md,
container/Dockerfile, container/agent-runner/package.json (UD),
container/agent-runner/src/ipc-mcp-stdio.ts (UD),
container/agent-runner/src/providers/index.ts,
container/skills/capabilities/SKILL.md (UD),
container/skills/status/SKILL.md (UD)

### SHARED (decide together before either touches)
- modify/delete on:
  - src/db.ts / db.test.ts / db-migration.test.ts (upstream split into src/db/*)
  - src/sender-allowlist.* (we forked into modules/sender-allowlist-fork; upstream deleted)
  - src/task-scheduler.* (we forked into task-scheduler-fork-bridge; upstream deleted)
  - src/session-cleanup.ts (upstream deleted, we still call)
  - src/remote-control.* (upstream deleted)
  - src/group-queue.* (upstream deleted)
  - src/routing.test.ts (upstream deleted, our v2 dispatcher tests live here)
  - src/formatting.test.ts (upstream deleted)
  - src/ipc.ts / logger.ts (upstream deleted; check call sites)
  - container/agent-runner/package-lock.json + ipc-mcp-stdio.ts (upstream deleted; we removed from build?)
  - container/skills/{capabilities,status}/SKILL.md (upstream deleted; rpi5 wants them?)
- Each modify/delete needs a "fork-only keep / upstream delete / port to upstream module" call

## Suggested order
1. SHARED triage meeting (15 min) — settle each modify/delete decision in this doc
2. VM resolves modules + container + top-level src (~50 conflicts) on `merge/vm-modules`
3. RPI5 resolves db + channels + setup (~25 conflicts) on `merge/rpi5-db-channels`
4. Last person rebases onto first person's branch, fixes any cross-cutting drift
5. Squash both into `chore/2026-04-30-v2-mergeback`, tsc + vitest green, single PR

## Process
- Do NOT push the half-merged branch — keep WIP local
- Daily PR rule: ONE PR for the whole mergeback day
- Don't touch the other person's owned files; if you must, paste the diff in chat first
