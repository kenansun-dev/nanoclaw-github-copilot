#!/usr/bin/env bash
# v2-mergeback-vm-resolutions.sh
#
# Replays VM-side conflict resolutions for the v2-merge ↔
# upstream/feat/migrate-from-v1 mergeback (2026-04-30).
#
# RUN this AFTER `git merge --no-commit --no-ff upstream/feat/migrate-from-v1`
# from a clean v2-merge worktree. Resolves ~75 VM-owned conflicts.
# Leaves rpi5-owned files (src/db/*, src/channels/*, setup/*, webhook-server,
# groups/*/CLAUDE.md, container/skills/{capabilities,status}, container/agent-runner/*UD)
# untouched for rpi5 to handle.
#
# Decisions encoded:
#   - Most src/modules/* conflicts: prettier-reflow only at 120 cols → take upstream
#   - mount-security/index.ts: keep fork (re-export wrapper, decided 2026-04-28)
#   - src/{log,types,router,config}.ts: keep fork (critical add-ons / large divergence)
#   - src/{index,container-runner,container-runner.test}.ts: keep fork
#     (heavily forked; B.6+ upstream features need follow-up port)
#   - src/{env,delivery,host-sweep*,host-core.test,container-runtime*,session-manager}.ts:
#     pure prettier reflow → take upstream
#   - SHARED modify/delete:
#       accept-delete: session-cleanup, remote-control(.test), group-queue(.test)
#       keep-fork: ipc, logger, sender-allowlist(.test), task-scheduler(.test),
#                  formatting.test, routing.test
#   - lockfiles (UD): keep ours, regen later
#   - .gitignore, vitest.config.ts: hand-merged in script
#   - container/Dockerfile, container/agent-runner/{src/ipc-mcp-stdio,src/providers/index}.ts: keep fork
#   - CLAUDE.md, README.md, .github/workflows/ci.yml, package*.json, repo-tokens/badge.svg: keep fork

set -euo pipefail

# ---------- safety check ----------
if ! git diff --name-only --diff-filter=U | grep -q .; then
  echo "No unmerged paths — nothing to do."
  exit 0
fi

echo "[1/6] Module conflicts: take upstream for 32 of 33 (mount-security keep-fork)"
take_upstream_modules=(
  src/modules/agent-to-agent/agent-route.ts
  src/modules/agent-to-agent/create-agent.ts
  src/modules/agent-to-agent/db/agent-destinations.ts
  src/modules/agent-to-agent/write-destinations.ts
  src/modules/approvals/index.ts
  src/modules/approvals/onecli-approvals.ts
  src/modules/approvals/picks.test.ts
  src/modules/approvals/primitive.ts
  src/modules/approvals/response-handler.ts
  src/modules/interactive/index.ts
  src/modules/permissions/access.ts
  src/modules/permissions/channel-approval.ts
  src/modules/permissions/channel-approval.test.ts
  src/modules/permissions/db/agent-group-members.ts
  src/modules/permissions/db/pending-channel-approvals.ts
  src/modules/permissions/db/pending-sender-approvals.ts
  src/modules/permissions/db/user-dms.ts
  src/modules/permissions/db/user-roles.ts
  src/modules/permissions/db/users.ts
  src/modules/permissions/index.ts
  src/modules/permissions/permissions.test.ts
  src/modules/permissions/sender-approval.ts
  src/modules/permissions/sender-approval.test.ts
  src/modules/permissions/user-dm.ts
  src/modules/scheduling/actions.ts
  src/modules/scheduling/db.ts
  src/modules/scheduling/db.test.ts
  src/modules/scheduling/recurrence.ts
  src/modules/scheduling/recurrence.test.ts
  src/modules/self-mod/apply.ts
  src/modules/self-mod/request.ts
  src/modules/typing/index.ts
)
for f in "${take_upstream_modules[@]}"; do
  [ -e "$f" ] || git checkout --theirs -- "$f" 2>/dev/null || true
  git checkout --theirs -- "$f"
  git add -- "$f"
done
git checkout --ours -- src/modules/mount-security/index.ts
git add src/modules/mount-security/index.ts

echo "[2/6] SHARED modify/delete decisions"
# accept-delete (only src/index.ts importer; index.ts itself is keep-fork
# so callers will be removed in a follow-up cleanup commit)
for f in src/session-cleanup.ts src/remote-control.ts src/remote-control.test.ts \
         src/group-queue.ts src/group-queue.test.ts; do
  git rm -- "$f" 2>/dev/null || true
done
# keep-fork (re-add the file we kept)
for f in src/ipc.ts src/logger.ts \
         src/sender-allowlist.ts src/sender-allowlist.test.ts \
         src/task-scheduler.ts src/task-scheduler.test.ts \
         src/formatting.test.ts src/routing.test.ts; do
  [ -e "$f" ] && git add -- "$f"
done

echo "[3/6] Lockfiles: keep ours (regenerate after commit)"
for f in package-lock.json container/agent-runner/package-lock.json; do
  [ -e "$f" ] && git add -- "$f"
done

echo "[4/6] Top-level fork-divergent files: keep ours"
for f in CLAUDE.md README.md .github/workflows/ci.yml package.json \
         container/agent-runner/package.json repo-tokens/badge.svg \
         container/Dockerfile \
         container/agent-runner/src/ipc-mcp-stdio.ts \
         container/agent-runner/src/providers/index.ts \
         src/log.ts src/types.ts src/router.ts src/config.ts \
         src/index.ts src/container-runner.ts src/container-runner.test.ts; do
  if git diff --name-only --diff-filter=U | grep -qx "$f"; then
    git checkout --ours -- "$f"
    git add -- "$f"
  fi
done

echo "[5/6] Pure-reflow VM src files: take upstream"
for f in src/env.ts src/delivery.ts \
         src/host-sweep.ts src/host-sweep.test.ts src/host-core.test.ts \
         src/container-runtime.ts src/container-runtime.test.ts \
         src/session-manager.ts src/state-sqlite.ts \
         src/claude-md-compose.ts src/command-gate.ts src/container-config.ts \
         src/group-init.ts src/providers/provider-container-registry.ts; do
  if git diff --name-only --diff-filter=U | grep -qx "$f"; then
    git checkout --theirs -- "$f"
    git add -- "$f"
  fi
done

echo "[6/6] Hand-merged: .gitignore + vitest.config.ts"
# .gitignore: union (keep our groups/main+global allowlist + take upstream's CLAUDE.local guards)
if git diff --name-only --diff-filter=U | grep -qx '.gitignore'; then
  cat > .gitignore.merged <<'EOF'
# Dependencies
node_modules/
.npm-cache/
# pnpm content-addressable store (created when running in sandbox mode)
.pnpm-store/
# Build output
dist/

# Local data & auth
store/
data/
logs/

# Groups - per-installation state, only track allowlisted CLAUDE/COPILOT files
groups/*
!groups/main/
!groups/global/
groups/main/*
groups/global/*
!groups/main/CLAUDE.md
!groups/main/COPILOT.md
!groups/global/CLAUDE.md
!groups/global/COPILOT.md

# Composer-managed CLAUDE.md artifacts (regenerated every spawn) and
# per-group memory (CLAUDE.local.md) must never be committed.
**/CLAUDE.local.md
**/.claude-shared.md
**/.claude-fragments/

# Secrets
*.keys.json
.env
.env*

# Temp files
.tmp-*

# OS
.DS_Store

# IDE
.idea/
.vscode/

# Skills system (local per-installation state)
.nanoclaw/
EOF
  mv .gitignore.merged .gitignore
  git add .gitignore
fi

if git diff --name-only --diff-filter=U | grep -qx 'vitest.config.ts'; then
  cat > vitest.config.ts <<'EOF'
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/agent-runner-ghc/* uses vitest (no bun:* deps), include it.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'test/**/*.test.ts',
      'container/agent-runner-ghc/src/**/*.test.ts',
    ],
    exclude: ['test/e2e/**'],
  },
});
EOF
  git add vitest.config.ts
fi

echo
echo "=== VM resolutions applied. Remaining unmerged (rpi5 territory): ==="
git diff --name-only --diff-filter=U
echo
echo "Once rpi5 territory is resolved + tsc/test pass, commit with:"
echo "  git commit -m 'merge upstream/feat/migrate-from-v1 into v2-merge (B.6+ catch-up)'"
