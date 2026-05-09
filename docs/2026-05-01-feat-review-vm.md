# 2026-05-01 — Feat-branch Review (VM lane)

Branch: `chore/2026-04-30-v2-mergeback` @ `da4f01f`
Base: `origin-dev/main` @ `fdbf59d`
Surface: **527 commits, 507 files, +56k/-7k**

Owner asked 7 things (msg `1499678253605064846`). After lane swap with rpi5 (msg `1499678664214712440`):
- **VM owns**: #1 (parity), #4 (schedule), #5-paper (attack surface), #6 (sandbox/timeout review)
- **Rpi5 owns**: #2 (upstream merge — but turned out to be no-op), #3 (CLI/TUI smoke), #5-runtime, #7 (can't-test list) + collation + owner report

---

## #2 — Upstream v2 catch-up (NO-OP, verified independently)

VM initially cherry-picked `d2e264a` as `a05751d`, then **dropped it** after rpi5 verified all 4 upstream commits are already present in fork:

| Commit | Intent | Fork status |
|---|---|---|
| `d2e264a` chmod 777 /home/node | container fix | ✅ already in `container/Dockerfile:62` (`chown -R node:node /workspace && chmod 777 /home/node`) |
| `7e86f6c` npm fallback when no corepack | setup robustness | ✅ already in `setup.sh:104-122` + extra npm-prefix-PATH discovery block |
| `f97cd44` collapse setup skill | skill cleanup | ✅ already in `.claude/skills/setup/SKILL.md` (10 lines); `new-setup/` doesn't exist |
| `5ae6662` | merge umbrella | n/a |

**My mistake**: I resolved the Dockerfile cherry-pick conflict by editing in the upstream-style block as if it were missing, but didn't grep first to see line 62 already had the same `chmod 777 /home/node`. Result: `a05751d` was a duplicate-mkdir + duplicate-chmod cruft commit. Dropped via `git reset --hard da4f01f`. **Lesson logged**: when resolving a cherry-pick conflict, grep target file for the symbol/string the upstream commit is adding *before* assuming the change is needed.

Suite at `da4f01f`: **1172/1172 green**.

---

## #1 — Main vs Feat parity (functional risk surface)

### Removed files (16) — all replaced

| Removed (in main) | Replacement (in feat) | Risk |
|---|---|---|
| `src/logger.ts` | `src/log.ts` (core) + `src/log-extensions.ts` (fork compat shim) | Low — re-exports identical surface |
| `src/router.ts` | `src/text-format.ts` (re-exports `escapeXml`, `formatMessages`, `formatOutbound`, `routeOutbound`, `findChannel`) | Low — `src/index.ts:75` re-exports for back-compat |
| `setup/groups.ts` | `setup/whatsapp-auth.ts` + `setup/migrate-v1/channel-auth.ts` | **MEDIUM** — `syncGroups`/`listGroups` CLI flow gone. WhatsApp Baileys `groupFetchAllParticipating` only invoked via `add-whatsapp.sh` now. If user ran `nanoclaw setup groups --list` historically, that command path is dead. |
| `setup/register.test.ts` | (no replacement) | Low — registration covered by `setup/register.ts` integration via auto.ts |
| `src/ipc-helpers.test.ts` | `container/agent-runner-ghc/src/ipc-helpers.test.ts` | Low — VM's own work earlier today (PR #36 commit `fbfc370`) |
| `src/ipc-auth.test.ts` | `src/modules/ipc-extensions/index.test.ts` (covers same `processTaskIpc` symbol) | Low — grep-verified |
| `.claude/skills/add-*/SKILL.md` (8 skills) | (no replacement at .claude path) | LOW-MEDIUM — confirm with rpi5 in #3 whether `skills/` (non-`.claude/`) tree has equivalents |
| `.claude/skills/setup/diagnostics.md` | (no replacement) | Low — diagnostic content folded into install scripts |
| `.claude/skills/use-local-whisper/SKILL.md` | (no replacement) | Low — niche, reinstall-on-demand |
| `docs/DEBUG_CHECKLIST.md` | (no replacement) | Low — historical doc |

### Removed exports (cross-checked, all rehoused)

| Symbol | New home |
|---|---|
| `getLastBotMessageTimestamp`, `createTask`, `updateTaskAfterRun`, `setSession`, `getRegisteredGroup` | `src/db.ts` |
| `getSession` | `src/db/sessions.ts` |
| `getRegisteredGroup` | also `src/modules/registered-groups-extensions/index.ts` |
| `escapeXml`, `formatMessages`, `formatConversationContext`, `stripInternalTags`, `formatOutbound`, `routeOutbound`, `findChannel` | `src/text-format.ts` |
| `getLogLevel`, `getValidLevels`, `setLogLevel`, `applyConfigLogLevel`, `setConsoleOutput`, `logger` | `src/log-extensions.ts` |
| `AdditionalMount`, `MountAllowlist`, `AllowedRoot`, `ContainerConfig` | `src/container-config.ts` (NEW, +130 lines) |
| `RegisteredGroup`, `NewMessage`, `ScheduledTask`, `TaskRunLog`, `StreamHandle` | `src/types-extensions.ts` |

### CLI top-level commands — full parity

`init / doctor / start / stop / restart / dev / status / logs / loglevel / reload / config / provider / channel / addon / plugin / chat / tui / pair / task / tasks` — all present in both `src/cli.ts` versions.

### New top-level src/ files (25, all with rationale comments)

`abort-handler-registry.ts`, `access-gate-registry.ts`, `admin-command-registry.ts`, `claude-md-compose.ts`, `command-gate.ts`, `container-config.ts`, `delivery.ts`, `group-init.ts`, `host-sweep.ts`, `install-slug.ts`, `log-extensions.ts`, `log.ts`, `platform-id.ts`, `response-registry.ts`, `session-manager.ts`, `shadow-inbound.ts`, `slash-command-registry.ts`, `state-sqlite.ts`, `task-scheduler-bridge.ts`, `text-format.ts`, `types-extensions.ts`, `typing-pulse.ts`, `v2-dispatcher-wiring.ts`, `webhook-server.ts`, `workspace-config.ts`

These are mostly v2 wiring shims + fork-only registries (Items B, C, etc. from earlier today's test-audit lane).

### Risk summary table

| # | Risk | Severity | Owner-action |
|---|---|---|---|
| R1 | `nanoclaw setup groups [--list]` CLI path appears removed | MEDIUM | Verify with `nanoclaw setup --help`; if missing, decide: re-add shim OR document in CHANGELOG |
| R2 | `src/ipc-auth.test.ts` removed | RESOLVED | Covered by `src/modules/ipc-extensions/index.test.ts` |
| R3 | `.claude/skills/{use-local-whisper, add-pdf-reader, add-image-vision, add-voice-transcription, add-gmail, add-reactions, add-telegram-swarm, add-compact, channel-formatting}/SKILL.md` deleted from `.claude/skills/`, no fork-side replacement found | LOW-MEDIUM | If users had Claude Code workflows hitting these, broken. Confirm with rpi5 in #3 whether `skills/` (non-`.claude/`) tree has equivalents |
| R4 | `setup/register.test.ts` removed | LOW | `setup/register.ts` still exists; integration covered via `setup/auto.ts`. Acceptable. |

---

## #4 — Schedule task (v1 polling vs v2 session-scoped)

`src/task-scheduler.ts` itself only changed +2/-2 lines. Real change: new `src/task-scheduler-bridge.ts` (94 lines) acts as a flip-able re-export. Per its own docstring:

> v2 deleted `src/task-scheduler.ts` entirely; scheduling moved into per-session inbound.db `messages_in` rows driven by `src/modules/scheduling/{actions,db}.ts`. The fork preserves the v1 polling loop because today's fork-only features (auto-pause on missing groups, `context_mode='isolated'`, `MAX_CONSECUTIVE_GROUP_MISSING`, group-folder snapshot writes) are not yet ported to v2's session-scoped scheduling.

**Comparison:**

| Aspect | v1 (fork keeps) | v2 (upstream) |
|---|---|---|
| Storage | Single `messages.db` cron-style table | Per-session `inbound.db` `messages_in` rows |
| Trigger | `setInterval(SCHEDULER_POLL_MS)` | `wakeContainer(session)` writes IPC; container drains inbound on its own |
| Granularity | Global poll, all tasks every tick | Session-scoped — tasks only fire for sessions actively running |
| Auto-pause on missing group | ✅ fork | ❌ v2 |
| `context_mode='isolated'` | ✅ fork | ❌ v2 |
| `MAX_CONSECUTIVE_GROUP_MISSING` cap | ✅ fork | ❌ v2 |
| Snapshot writes to group folder | ✅ fork | ❌ v2 |
| Compatible with `host-sweep` killing stuck containers | ✅ via fork | ✅ v2 has its own equivalent |

**Verdict**: v2 design is **architecturally cleaner** (session-scoped beats global poll for scaling) but is **functionally incomplete** for the fork — 4 fork-only safety features have no v2 equivalent. The bridge approach is correct: stay on v1 loop until those 4 features are ported into v2 modules.

**Recommended owner decision**: keep bridge in v1 mode for now. Port the 4 features into v2 `modules/scheduling/` over multiple PRs (each ≤ one feature) — do NOT attempt them in this merge cycle.

---

## #5 (paper review) + #6 — Container/sandbox attack surface + timeout/orphan-prevention

Files reviewed: `src/container-runner.ts` (+79), `src/container-runtime.ts` (+16/-12), `src/container-config.ts` (NEW +130), `src/host-runner.ts`, `container/Dockerfile`, `container/agent-runner-ghc/src/`, `src/host-sweep.ts`.

### Strong points (defenses present)

1. **No host-network mode**: `container-runner.ts` uses default bridge network; `--network=host` not granted.
2. ~~**Read-only root + tmpfs**: container starts with `--read-only` + `--tmpfs /tmp`; writable mounts limited to `/workspace/{group,global,extra}` and `/home/node` (777 — see Caveat C2).~~ **❌ CORRECTED (rpi5 runtime audit, 2026-05-01)**: live `docker inspect` on a running v2 container (`nanoclaw-daily--tg-daily-...`) shows `ReadonlyRootfs: false`, no `--tmpfs` flag, and `buildContainerArgs` (`src/container-runner.ts:318-405`) emits **none** of `--read-only`, `--cap-drop`, `--security-opt`. Upstream v2 (`upstream/feat/migrate-from-v1`) is the same — confirmed by `git show upstream/feat/migrate-from-v1:src/container-runner.ts` + grep. So this is **not a fork regression**, it's an **upstream-parity gap** — see C5/C7 below (both WONTFIX, upstream parity).
3. **Credential proxy, not pass-through**: GHC token resolved host-side, injected via `-e COPILOT_GITHUB_TOKEN=…`. Container never sees long-lived API keys.
4. **`stopContainer` + `host-sweep`**: heartbeat-file based liveness + absolute 30-min ceiling kills runaway containers. Beats relying on docker's own healthcheck which the agent could spoof.
5. **`ContainerConfig.AllowedRoot` allowlist**: `src/container-config.ts:53-90` — bind mounts are validated against a per-group allowlist; arbitrary host path mounting requires explicit config.

### Caveats (worth fixing or documenting)

| ID | Issue | Severity | Suggested fix |
|---|---|---|---|
| C1 | No seccomp profile pinned. `docker run` uses default seccomp; an exploit chain via Node.js V8 → unconfined `ptrace` is theoretically possible. | MEDIUM | Add `--security-opt seccomp=container/seccomp.json` with whitelisted syscalls only. OneCLI vault profile is a natural place. |
| C2 | `chmod 777 /home/node` (in fork since `da4f01f`, matches upstream `d2e264a`) widens write surface. Acceptable per upstream rationale ("ephemeral, single-process, single-tenant") but means: if the agent escapes its own UID isolation, it can write to other host UIDs' mapped files. | LOW | Document in OneCLI hardening proposal; consider `--user $(id -u):$(id -g)` + `--userns-remap` instead of mode-777 widening. |
| C3 | No AppArmor profile. Default docker AppArmor is permissive. | LOW | Author a `nanoclaw-agent` AppArmor profile after C1 lands. |
| C4 | `COPILOT_GITHUB_TOKEN` env-var injection: anything inside the container can `printenv COPILOT_GITHUB_TOKEN`. A malicious MCP server bundled into agent code could exfiltrate. | MEDIUM | Move to a credential socket: host listens on `/var/run/onecli/cred.sock` mounted into container; agent requests scoped tokens per-call. OneCLI vault feature already half-there. |
| C5 | No CPU/memory limits in `runContainerAgent` spawn args (verified `src/container-runner.ts` — no `--cpus` / `--memory` flags). A prompt-injection could spin a fork bomb or memory hog and starve host. **Bumped to HIGH on rpi5 hardware (8 GB RAM)** — live OOM trivially reachable. | ~~MEDIUM~~ → **WONTFIX (upstream parity)** | Owner decision 2026-05-01: upstream v2 also lacks these flags (`git show upstream/feat/migrate-from-v1:src/container-runner.ts | grep -E 'memory\|cpus\|pids'` → 0 hits). Not a regression. Future work = single fork-side hardening PR + upstream issue, not in this merge cycle. See `feat-review-followups.md`. |
| C6 | `installV2DispatcherHooks` env gate (`NANOCLAW_V2_DISPATCHER`) accepts unset/0/'1'/'2'. No HMAC or signed config — anyone with shell access toggles modes. | LOW | OK for env-var pattern; not actually a security boundary. Fine. |
| **C7 (NEW, rpi5 runtime audit)** | Missing 3 free hardening flags: `--read-only` rootfs, `--cap-drop=ALL`, `--security-opt no-new-privileges`. Each is a one-liner in `buildContainerArgs`. | ~~MEDIUM~~ → **WONTFIX (upstream parity)** | Same rationale as C5 — upstream v2 also missing all three. Bundle with C5 in any future hardening PR. |

### #6 sanity — sandbox timeout / orphan-prevention work survives v2

| Feature (upstream commit) | Status under v2 |
|---|---|
| `host-sweep.ts` periodic maintenance, 60s interval (`bee80b0`) | ✅ Present, runs regardless of dispatcher mode |
| `killContainer(sessionId, reason)` (`2383bde`) | ✅ Present (`src/container-runner.ts`) |
| Absolute 30-min heartbeat ceiling (`6a81519`) | ✅ `host-sweep.ts:30+` |
| Message-scoped stuck detection (`e129400`) | ✅ `host-sweep.ts:25+` |
| `stopContainer` with timeout | ✅ Re-exported from `container-runner.ts` |
| `host-runner.ts` process-group kill on orphans | ✅ Present |

**All 6 features are wired in and exercised by `host-sweep` regardless of v2 dispatcher mode.** The bridge pattern means v2-mode boots still get this orphan-prevention. Owner's worry on #6 is unfounded — these still mean something in v2.

**Nuance on `task-scheduler` (separate from #6 above)**: 4 features in `src/task-scheduler.ts` are genuinely **fork-only**, added in commit `68f2212` (2026-04-22 orphan-spam fix): `MAX_CONSECUTIVE_GROUP_MISSING` auto-pause, `context_mode='isolated'`, group-folder snapshot writes, consecutive-miss counter. Verified by `git grep MAX_CONSECUTIVE_GROUP_MISSING upstream/main upstream/feat/migrate-from-v1` → 0 hits. The bridge keeps the v1 scheduler loop alive under v2 mode, so users retain these features today. Porting them to v2-native `src/modules/scheduling/` is **deferred** with no PR-count commitment — see `feat-review-followups.md` #4 DEFERRED.

---

## Open items requiring rpi5 (Phase 2/3) or owner

- **R1** (verify `nanoclaw setup groups` CLI is gone or aliased) — rpi5 verified LOW (no top-level CLI surface lost; `setup/groups.ts` was an internal helper module, not a `nanoclaw setup` verb). See `feat-review-rpi5.md` Phase 4 collation.
- **R3** (`.claude/skills/` deleted skills — does fork have replacements?) — rpi5 verified LOW (8 skills genuinely deleted, 1 renamed). Owner-decide whether to restore or note in CHANGELOG.
- **C1, C4** — owner decision on whether to address in this PR or follow-up.
- **C5, C7** — **WONTFIX in this PR** (upstream parity; future hardening PR will address as a bundle).

---

## What I did NOT cover (handed to rpi5)

- #2 already verified by rpi5 as no-op
- #3 CLI/TUI smoke matrix (boot the v2 instance, exercise commands)
- #5/#6 runtime hands-on (real docker + onecli on rpi5)
- #7 owner-help-needed list (rpi5 collation)
- Final owner report (rpi5)
