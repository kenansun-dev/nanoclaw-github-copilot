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

| upstream | intent | our state |
|---|---|---|
| `d2e264a` `make /home/node writable for mapped UIDs` | container UID-mapping fix | ✅ already in `container/Dockerfile:62` (`chmod 777 /home/node`) |
| `7e86f6c` `fall back to npm install when corepack missing` | setup bootstrap robustness | ✅ already in `setup.sh:104-122` (near-identical text, landed in earlier mergeback) |
| `f97cd44` `collapse setup skill to one instruction` | skill cleanup, deletes 700 lines | ✅ already in `.claude/skills/setup/SKILL.md` (10 lines; `new-setup/` not present) |
| `5ae6662` (merge umbrella) | n/a | n/a |

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

| command | result |
|---|---|
| `--version` | `nanoclaw v0.0.1-alpha` |
| `status` | clean output, shows uninitialized workspace correctly |
| `doctor` | 9/10 checks pass; 1 expected fail ("no chats registered" on fresh ws) |
| `sandbox status` | lists 3 images + "No running containers" |
| `chat list` | "No registered chats" — correct |
| `task list` | "No scheduled tasks" — correct |
| `provider status` | `✅ github-copilot: authenticated (OpenClaw profile)` |
| `channel list` | shows telegram + teams disabled — correct |
| `mcp list` | "No MCP servers configured" — correct |

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

Filed in followups.md as **P1: tui --ask sandbox path doesn't write
close-sentinel after first output** with two candidate fixes for VM
to weigh in on.

### Commands not yet tested (need the host running or interactive)

| command | reason |
|---|---|
| `start` / `stop` / `restart` | would clobber my v1 systemd unit; need to do this in a clean systemd-less env or use `dev` mode |
| `dev` | foreground daemon — can run isolated, queued for next pass |
| `tui` (interactive, no `--ask`) | needs TTY + manual interaction |
| `pair` / `chat add` | interactive flow + a real channel JID |
| `init` | would re-init my isolated workspace with prompts |
| `update` | side-effecting |
| `mcp daemon start` | side-effecting |
| `sandbox build` | rebuilds image (slow), tested elsewhere |

## #5 — Sandbox / OneCLI runtime audit

(pending Phase 3 — depends on the `--ask` fix decision so we can keep
exercising the sandbox path without each test orphaning a container)

## #7 — Can't-test list (running)

Things owner-only or out-of-scope for this rpi5 lane:

- Real Telegram / Discord guild prod webhooks (need owner's bot tokens
  + the actual prod guilds; smoke tests would spam those channels)
- Real GHC quotas / rate-limit behavior (only the owner's GitHub
  account hits rate-limit caps; my smoke is single-shot)
- macOS UID-mapping path of `d2e264a` (rpi5 is Linux; needs owner to
  verify on macOS)
- Interactive TUI keyboard flow (need a real terminal session, not
  scripted)
- Browser-based `pair` flow (needs real channel + mobile or QR)
- Multi-chat groups / cross-chat task scheduling (needs >=2 chats
  registered + real channel events)
