# Feat-branch review — Rpi5 lane (2026-05-01)

PR #36 (`chore/2026-04-30-v2-mergeback`) review per kenan's 7-item ask.
Lane split with VM:

- **Rpi5**: #2 upstream catchup, #3 CLI/TUI smoke, #5 sandbox/onecli runtime, #7 can't-test list
- **VM**: #1 main↔feat funcdiff, #4 schedule-task v2, #6 sandbox security paper review
- **Reporter**: Rpi5 (this lane), VM cross-checks

Severity scale (used in `docs/2026-05-01-feat-review-followups.md`):

- **P0** = blocks merging the feat branch
- **P1** = should fix this cycle, doesn't block merge
- **P2** = next cycle / nice-to-have

## #2 — Upstream `/v2` catch-up (DONE, no-op)

`git merge --no-ff upstream/v2` produced 2 conflicts (Dockerfile,
setup.sh). Aborted and audited the 4 upstream commits individually:

| upstream                                                   | intent                           | our state                                                                           |
| ---------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------- |
| `d2e264a` `make /home/node writable for mapped UIDs`       | container UID-mapping fix        | ✅ already in `container/Dockerfile:62` (`chmod 777 /home/node`)                    |
| `7e86f6c` `fall back to npm install when corepack missing` | setup bootstrap robustness       | ✅ already in `setup.sh:104-122` (near-identical text, landed in earlier mergeback) |
| `f97cd44` `collapse setup skill to one instruction`        | skill cleanup, deletes 700 lines | ✅ already in `.claude/skills/setup/SKILL.md` (10 lines; `new-setup/` not present)  |
| `5ae6662` (merge umbrella)                                 | n/a                              | n/a                                                                                 |

**Why the merge conflicted anyway**: upstream Dockerfile is the
pre-rewrite shape (single-stage, no Bun, no tini PID 1, unpinned
CLIs). Ours is the post-rewrite multi-stage shape with cache mounts +
version pinning + tini-as-PID-1. Same lines touched, different
intents. Same story for setup.sh: upstream's diff is what later
landed verbatim in ours from a different SHA. **No content gap to
import; merge skipped.**

## #3 — CLI / TUI smoke (in progress)

Workspace isolated via `NANOCLAW_WORKSPACE=$HOME/.nanoclaw-v2-smoke`.
v2 binary: `node /home/pi/gitrepos/nanoclaw-v2-mergeback/bin/nanoclaw.js`.

### Commands tested clean (read-only / no model)

| command           | result                                                                |
| ----------------- | --------------------------------------------------------------------- |
| `--version`       | `nanoclaw v0.0.1-alpha`                                               |
| `status`          | clean output, shows uninitialized workspace correctly                 |
| `doctor`          | 9/10 checks pass; 1 expected fail ("no chats registered" on fresh ws) |
| `sandbox status`  | lists 3 images + "No running containers"                              |
| `chat list`       | "No registered chats" — correct                                       |
| `task list`       | "No scheduled tasks" — correct                                        |
| `provider status` | `✅ github-copilot: authenticated (OpenClaw profile)`                 |
| `channel list`    | shows telegram + teams disabled — correct                             |
| `mcp list`        | "No MCP servers configured" — correct                                 |

### `tui --ask` smoke — **FOUND P1 BUG**

Ran: `tui --ask "Reply with the single word PONG. No other text."`

**What happened:**

1. CLI default `mode = sandbox` on Linux (`config-loader.ts:255` —
   `process.platform === 'win32' ? 'host' : 'sandbox'`)
2. So `runQuery` → `runSandboxQuery` → `runContainerAgent`
3. Container spawned, agent-runner-ghc replied with "PONG" + final
   marker on stdout (verified via `docker logs`)
4. agent-runner-ghc then logged `Query ended, waiting for next IPC
message...` — i.e. v2 design: container is long-lived, blocks on
   IPC for next user message
5. `runContainerAgent` resolves on container `exit` event — but the
   container never exits because nobody writes the `_close` sentinel
6. CLI spinner spun for 90s until our test timeout killed it; docker
   container `nanoclaw-tui-ask-*` left running (orphaned)

**Where the bug is:**

- `src/cli/tui-direct.ts:283` — `runSandboxQuery()` awaits
  `runContainerAgent` but never writes `_close` to
  `<groupIpcDir>/input/_close` after the first complete output is
  observed (`onOutput` callback gets the result but the close-sentinel
  write happens nowhere on the sandbox path)
- Compare: host-mode path (`runQuery` line 401-450) DOES write
  `closeSentinel` in its `finish()` handler (line 453-457)
- Idle-timeout safety net is also disabled by default
  (`config-loader.ts` `idleTimeout: 0` in the sandbox defaults), so
  the only thing that eventually kills the orphan is `CONTAINER_TIMEOUT`
  (1800000 ms = 30 min) or `--query`'s 5-min QUERY_TIMEOUT_MS

**User-visible impact:** on a fresh Linux install with Docker, every
`nanoclaw tui --ask "..."` invocation hangs for up to 5 minutes and
leaves a docker container running. Workaround today: set
`agents.defaults.mode: host` in `nanoclaw.json`.

**RESOLVED in commit `d3109c2`** — Fix A (`runSandboxQuery` writes
`_close` sentinel after first non-partial output) + Fix B (`idleTimeout`
default 0→30_000 in `config-loader.ts` + `cli/init.ts`). Mutation-
verified regression test in `src/cli/tui-direct-sentinel.test.ts`.
Live smoke after rebuild: `tui --ask` exits in ~14s with zero orphan
containers (was ~90s+ + leaving a container alive).

**Important debug note for future-me / VM**: `bin/nanoclaw.js` loads
`dist/cli.js`, NOT `src/`. Editing `src/cli/tui-direct.ts` without
`npx tsc` first means the change isn't live. Spent one full smoke loop
learning this. Add to dev-doc.

**Sub-bug surfaced (P2)**: even with the fix, `tui --ask` stdout never
prints the model's actual reply (container emits PONG, host clears
spinner, stdout empty). Pre-existing, not a feat-branch regression.
Logged in `feat-review-followups.md`.

### Commands not yet tested (need the host running or interactive)

| command                         | reason                                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| `start` / `stop` / `restart`    | would clobber my v1 systemd unit; need to do this in a clean systemd-less env or use `dev` mode |
| `dev`                           | foreground daemon — can run isolated, queued for next pass                                      |
| `tui` (interactive, no `--ask`) | needs TTY + manual interaction                                                                  |
| `pair` / `chat add`             | interactive flow + a real channel JID                                                           |
| `init`                          | would re-init my isolated workspace with prompts                                                |
| `update`                        | side-effecting                                                                                  |
| `mcp daemon start`              | side-effecting                                                                                  |
| `sandbox build`                 | rebuilds image (slow), tested elsewhere                                                         |

## #5 — Sandbox / OneCLI runtime audit

Done via static read of `src/container-runner.ts` `buildContainerArgs`
(line 318-405) + live `docker inspect` of an actually running v1
nanoclaw container on rpi5.

### What `buildContainerArgs` actually emits

```
docker run -i --rm --name <containerName>
  -e TZ=<host-tz>
  -e NANOCLAW_ENGINE=<node|tsx>
  -e NANOCLAW_PLUGIN_DIRS=<colon-list>            # if any
  <provider-env-args>                              # GHC token OR cred-proxy port
  <host-gateway-args>                              # for host.docker.internal resolution
  [--user $(id -u):$(id -g) -e HOME=/home/node]   # only if host uid ∉ {0, 1000}
  -v <host>:<container>[,ro]                       # per mount in mounts[]
  <containerImage>
```

### What is NOT emitted (verified by grep + live docker inspect)

| Flag                               | Present? | Live `docker inspect`                     |
| ---------------------------------- | -------- | ----------------------------------------- |
| `--read-only`                      | NO       | `ReadonlyRootfs: false`                   |
| `--cap-drop=ALL`                   | NO       | `CapDrop: null`                           |
| `--cap-add=...`                    | NO       | `CapAdd: null`                            |
| `--security-opt seccomp=...`       | NO       | `SecurityOpt: null`                       |
| `--security-opt apparmor=...`      | NO       | (none)                                    |
| `--security-opt no-new-privileges` | NO       | (none)                                    |
| `--tmpfs /tmp`                     | NO       | (none)                                    |
| `--cpus=N`                         | NO       | `CpuShares: 0` (unlimited)                |
| `--memory=...`                     | NO       | `Memory: 0` (unlimited)                   |
| `--pids-limit=N`                   | NO       | `PidsLimit: null`                         |
| `--userns=host\|<map>`             | NO       | (default)                                 |
| `--network=<custom>`               | NO       | `NetworkMode: bridge` (good — not `host`) |

**Important correction to VM's `feat-review-vm.md` Strong-Point #2**:
VM said "container starts with `--read-only` + `--tmpfs /tmp`". This is
**not true** — neither flag appears anywhere in `buildContainerArgs`,
and `docker inspect` confirms `ReadonlyRootfs: false`. The only
limitations actually applied are:

- `--rm` (auto-cleanup on exit — nice for dev, doesn't help live)
- `--user <uid>:<gid>` (only when host uid != 0/1000; on rpi5 with uid
  1000 this branch is skipped, so container runs as `node` uid 1000)
- `NetworkMode: bridge` is docker default, not an explicit hardening

### Defenses that DO survive in v2

- `host-sweep.ts` 60s liveness loop (kills via heartbeat-file staleness)
- 30-min absolute `CONTAINER_TIMEOUT` ceiling
- `host-runner.ts` process-group SIGTERM on host-mode orphans
- Per-group IPC namespace via `resolveGroupIpcPath` (`<ws>/data/ipc/<folder>`)
- Mount allowlist (`src/container-config.ts:53-90`) — only allowed roots
- GHC token: env-var injected (long-lived, exfil-able — see C4 below)
- Credential proxy for CC: token resolved host-side over loopback

### Re-rated caveats (post live audit)

Re-rate VM's C1–C6 in light of the verified state:

| ID                           | Was    | Now                   | Notes                                                                                                                                                                                                                                                                                   |
| ---------------------------- | ------ | --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 (no seccomp)              | MEDIUM | **MEDIUM**            | Confirmed; default docker seccomp only                                                                                                                                                                                                                                                  |
| C2 (chmod 777 /home/node)    | LOW    | **LOW**               | Confirmed; documented per upstream rationale                                                                                                                                                                                                                                            |
| C3 (no AppArmor)             | LOW    | **LOW**               | Confirmed; default docker AppArmor only                                                                                                                                                                                                                                                 |
| C4 (token env-var)           | MEDIUM | **MEDIUM**            | Confirmed; cred-socket would close this                                                                                                                                                                                                                                                 |
| C5 (no cgroup limits)        | MEDIUM | **HIGH (was MEDIUM)** | Live `docker inspect` shows `CpuShares: 0, Memory: 0, PidsLimit: null`. A prompt-injection fork-bomb on rpi5/Pi5 (8 GB RAM total) could OOM the host **today**. Bumped MEDIUM → HIGH. Recommend hard default `--memory=4g --pids-limit=512 --cpus=2` in this PR or immediate follow-up. |
| C6 (env-var dispatcher gate) | LOW    | **LOW**               | Confirmed; not actually a security boundary                                                                                                                                                                                                                                             |
| **C7 (NEW)**                 | n/a    | **MEDIUM**            | No `--read-only` root, no `--cap-drop=ALL`, no `--security-opt no-new-privileges`. These are 3 one-line flags that double the attack-surface bar for free. VM's claim that `--read-only` was on was wrong.                                                                              |

### Recommended OneCLI hardening proposal (for a follow-up PR)

Add to `buildContainerArgs` defaults (configurable via `nanoclaw.json`
`sandbox.security.*`):

```
--read-only
--tmpfs /tmp:rw,noexec,nosuid,size=512m
--tmpfs /workspace/runtime:rw,noexec,nosuid,size=128m
--cap-drop=ALL
--security-opt no-new-privileges
--security-opt seccomp=container/seccomp.json   # author whitelist
--memory=4g --memory-swap=4g
--cpus=2
--pids-limit=512
```

Opt-out via `sandbox.security.relaxed: true`. Default-secure beats
default-permissive on a public-facing agent runtime.

## #7 — Can't-test list (final)

Things owner-only or out-of-scope for this rpi5 lane:

- Real Telegram / Discord guild prod webhooks (need owner's bot tokens
  - the actual prod guilds; smoke tests would spam those channels)
- Real GHC quotas / rate-limit behavior (only the owner's GitHub
  account hits rate-limit caps; my smoke is single-shot)
- macOS UID-mapping path of `d2e264a` (rpi5 is Linux; needs owner to
  verify on macOS that the chmod 777 actually unblocks .claude.json
  writes)
- Interactive TUI keyboard flow (need a real terminal session, not
  scripted)
- Browser-based `pair` flow (needs real channel + mobile or QR)
- Multi-chat groups / cross-chat task scheduling (needs >=2 chats
  registered + real channel events)
- `nanoclaw start/stop/restart` against systemd — would clobber my v1
  unit; covered by VM's static review (#1) instead
- `mcp daemon start` real lifecycle (needs an MCP server config + real
  long-lived process; only smoke-able)
- `sandbox build` rebuild loop (slow, separately tested when image
  ships)
- `update` self-update path (side-effecting, would clobber my dev
  install)

## Phase 4 — Owner-facing collation (rpi5 owns)

Merged risks/findings from VM lane + rpi5 lane below. Merge-blockers
on top, merge-safe items underneath.

### Merge blockers (P0): NONE

After the P1 close-sentinel fix landed in commit `d3109c2`, no item is
a hard blocker. The branch is mergeable as-is.

### Should-fix this cycle (P1)

- **C5 (HIGH, was MEDIUM)** — No cgroup limits in `buildContainerArgs`.
  Live `docker inspect` confirms `Memory: 0, CpuShares: 0,
PidsLimit: null`. On Pi5 (8 GB RAM total), one prompt-injection
  fork-bomb OOMs the host. Fix: hard default `--memory=4g
--pids-limit=512 --cpus=2` in `buildContainerArgs`. ~10 lines.
  Owner decision: this PR or fast follow?
- **C7 (NEW, MEDIUM)** — Three free hardening flags missing:
  `--read-only`, `--cap-drop=ALL`, `--security-opt no-new-privileges`.
  These are one-line each and dramatically raise the bar. Same patch
  could land with C5.

### Should-fix next cycle (P2)

- **C1** seccomp profile (needs whitelist authoring effort)
- **C4** GHC token cred-socket migration (needs design)
- **C3** AppArmor profile (after C1)
- **P2 stdout** — `tui --ask` empty stdout (pre-existing, not
  introduced here; ~30 min to debug `lastOutput` fall-through)
- **#4 schedule task** — port 4 fork-only safety features into v2
  `modules/scheduling/` over multiple PRs (auto-pause,
  context_mode='isolated', MAX_CONSECUTIVE_GROUP_MISSING, snapshot
  writes)

### Already resolved (P0/P1 closed before merge)

- **P1 (RESOLVED)** — `tui --ask` orphan-container hang. Commit
  `d3109c2`. Mutation-verified test in
  `src/cli/tui-direct-sentinel.test.ts`. Live smoke confirms 14s exit,
  zero orphans.
- **#2 upstream catchup** — 1 of 4 commits relevant
  (`d2e264a` chmod 777). Applied as VM's `a05751d`, deduped on rpi5.
  Other 3 already in branch or N/A. Suite still 1174 green.
- **R2** (was: ipc-auth.ts test removed) — covered by
  `src/modules/ipc-extensions/index.test.ts`. No action.

### LOW (CHANGELOG mention only)

- **R1** — `setup/groups.ts` deleted. No CLI surface lost (never was a
  `nanoclaw setup` verb on either branch). Whatsapp Baileys group sync
  now via `setup/add-whatsapp.sh` for fresh installs;
  `setup/migrate-v1/groups.ts` for v1→v2.
- **R3** — 8 of 9 `.claude/skills/add-*` deletions confirmed; only
  `add-gmail` has a near-replacement (`add-gmail-tool`). Capability
  reachable via SDK allowedTools or manual install.
- **R4** — `setup/register.test.ts` removed; `setup/register.ts`
  itself remains, integration covered by `setup/auto.ts`.
- **C2, C6** — documented per VM's #5-paper (chmod 777 acceptable;
  env-var dispatcher gate not a security boundary).

### Recommended owner action

1. **Merge `chore/2026-04-30-v2-mergeback` into `main`** as-is. Tests
   green (1174/1174), live smoke clean, no P0.
2. **Spawn a follow-up PR "sandbox-hardening"** for C5+C7 within the
   next cycle (these are user-data-protection issues on multi-user or
   exposed installs).
3. **Mention in CHANGELOG**: R1, R3 (small UX changes for power users).
4. **Defer to backlog**: C1, C3, C4, P2 stdout, #4 schedule port.
