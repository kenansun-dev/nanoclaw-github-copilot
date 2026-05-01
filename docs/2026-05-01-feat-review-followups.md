# Feat-branch review followups (2026-05-01)

Cross-lane finding catalogue. Severities:

- **P0** = blocks merging the feat branch
- **P1** = should fix this cycle, doesn't block merge
- **P2** = next cycle / nice-to-have

Each entry: lane / what / where / why / candidate fix(es) / who-decides.

---

## P1 — `tui --ask` sandbox path leaks containers and hangs

**Lane**: rpi5 (#3)

**What**: On Linux/macOS, `nanoclaw tui --ask "<query>"` defaults to
sandbox mode (config-loader.ts:255 sets `mode = process.platform ===
'win32' ? 'host' : 'sandbox'`). The sandbox path
(`src/cli/tui-direct.ts:283 → runSandboxQuery → runContainerAgent`)
spawns a docker container, waits for the container to exit, and never
writes the `_close` IPC sentinel. Because v2 agent-runner-ghc is a
long-lived loop that blocks on next IPC message after each query, the
container never exits — host CLI spins forever on `thinking…` and
leaves an orphaned docker container.

`idleTimeout: 0` (config-loader.ts default) means the only fallback is
`CONTAINER_TIMEOUT` (1800000 ms = 30 min) before the container is
force-killed. Total user-visible hang: until QUERY_TIMEOUT_MS = 5 min,
then container stays orphaned for another 25 min.

**Where**:
- `src/cli/tui-direct.ts:552-610` `runSandboxQuery` — missing
  close-sentinel write after first complete output
- `src/cli/tui-direct.ts:288-450` `runQuery` (host-mode branch) — has
  the close-sentinel write at line 453-457; provides reference shape
- `src/config-loader.ts:255` — Linux/macOS sandbox default
- `src/config-loader.ts` `idleTimeout: 0` default — disables the safety net

**User-visible impact**: every `tui --ask` on a fresh Linux install
hangs ~5 min and leaks one docker container.

**Workaround today**: set `agents.defaults.mode: host` in
`nanoclaw.json`.

**Candidate fixes** (need agreement):

- **A (narrow)**: in `runSandboxQuery`, after first non-partial output
  observed in the `onOutput` callback, write the `_close` sentinel to
  `<groupIpcDir>/input/_close`. Mirrors host-mode behavior. Smallest
  blast radius. Behavioral test: spawn `runContainerAgent` with a
  fake long-lived child that emits one OUTPUT_START..END and then
  blocks; assert the host writes `_close` and the resolved status is
  success. Doesn't touch container-runner.ts at all.
- **B (broader, design change)**: change `idleTimeout` default from 0
  to e.g. 30_000 and let the existing `killOnTimeout` path handle it.
  Catches unrelated orphan-container scenarios too, but changes the
  performance characteristics for anyone relying on long-idle-then-resume
  (e.g. interactive `tui` mode).
- **C (both)**: A as the correct fix for `--ask`; B as defense in
  depth.

**Tests to add either way**:
- `src/cli/tui-direct.test.ts` (new): runSandboxQuery writes
  close-sentinel after first complete output; runSandboxQuery returns
  on container-exit even if no further output arrives
- e2e `tui-ask-sandbox.test.ts`: real container `tui --ask` round-trip
  asserts container is GONE within 5s of stdout result (gated on
  GHC token + image, like v2-container-smoke)

**Who decides**: VM (you have the `--ask`-path context from your B-lane
work + you'll touch close-sentinel semantics in B.5.5 task-scheduler
follow-ups). I'll implement whichever you pick and add the tests.

---

## (more entries appended as discovered)

---

## P1 RESOLVED — implemented A + B in commit `d3109c2`

Fix A landed in `src/cli/tui-direct.ts`; Fix B (idleTimeout 0 → 30_000)
landed in `src/config-loader.ts` and `src/cli/init.ts`. Regression
guard in `src/cli/tui-direct-sentinel.test.ts` (2 tests, mutation-
verified). Smoke confirms `tui --ask` exits in ~14s with zero orphan
containers (was hanging ~5 min + leaving a container alive).

---

## P2 — `tui --ask` (sandbox) prints empty result

**Lane**: rpi5 (#3 follow-up after the orphan fix unmasked it)

**What**: After the close-sentinel fix above, `tui --ask` now exits
cleanly in ~14s, but stdout shows no `PONG` (or whatever the model
actually replied). The container DID emit a complete `{status:
success, result: 'PONG'}` marker pair (verified via `docker logs` on
the earlier hang run), and `runContainerAgent` did call `onOutput`
with it (we know because the close-sentinel write triggered, which is
gated on a non-partial output arriving).

**Likely cause** (not yet verified): in streaming mode
`runContainerAgent` returns `{status: 'success', result: null}`
(`src/container-runner.ts` ~line 745). `runSandboxQuery` does
`return output.status === 'success' && output.result ? output : lastOutput`
so it should fall through to `lastOutput` which captured the PONG
in the callback. But somewhere between that return and the
`console.log(result.result)` at `tui-direct.ts:158`, the result is
empty. Worth a 30-min look with a `console.error` debug print.

**Why P2, not P1**: previously masked by the hang bug; not a
regression introduced by the feat branch (likely longstanding). Doesn't
block merge — interactive `tui` mode and channel-driven flows are
fine. Only `--ask` non-interactive mode is silent.

**Suggested fix**: probably one of
(a) `runSandboxQuery` should return `lastOutput` directly when
`output.result` is null, or
(b) `runContainerAgent` should populate `result` from the last
successful onOutput frame even in streaming mode.

---
