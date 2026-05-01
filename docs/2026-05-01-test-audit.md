# Test audit — v2 engineering quality (2026-05-01)

**Goal**: kenan asked to audit the test suite for v2 — find tests that
exist for coverage rather than to catch real regressions, and shore up
the gaps. Not adding tests for coverage; each new test must have a
concrete bug class it would catch.

Lanes:

- **Rpi5 (this doc)**: container/runner side, e2e expansion
- **VM**: dispatcher / ipc / shadow-inbound / workspace-config / config-extensions / task-scheduler-fork-bridge

## Audit gate (both lanes)

For every existing test, answer: **"What concrete regression would this test catch if it stayed in the suite, that nothing else catches?"**

- Answer is concrete (named bug shape) → keep
- Answer is "verifies the function returns the right thing in the happy
  case" → mark `// low-signal — covered by integration` and consider
  deletion or replacement
- Answer is "asserts mocks are called with expected args" with no real
  invariant tied to those calls → low-signal

## Rpi5 lane — findings

### `src/container-runner.parse.test.ts` (4 tests, 23 lines)

**Verdict**: KEEP. All 4 tests pin a concrete invariant — Copilot's
`config.json` has `// comment` lines on the first line that vanilla
`JSON.parse` rejects. Each test maps to a real failure mode (leading
comment, indented comment, plain JSON, hard-fail). Addressed in
`v2-merge ff5201b`.

### `src/container-runtime.test.ts` (~7 tests)

**Verdict**: KEEP. The `stopContainer` shell-injection guard test is
real protection (we pass user-controlled-ish names into `docker stop`
via `execSync` string concat). `cleanupOrphans` failure-tolerance tests
match real prod behavior we relied on after CLI bug #1967 left
zombies.

### `src/container-runner.test.ts` (3 tests, 272 lines)

**Verdict**: KEEP existing 3, **GAP: missing protocol invariants**.
Existing tests cover three timeout/exit ordering cases, all happy-path
"emit one marker → close → resolve". Real wire-protocol bug classes
not covered:

1. **Marker split across two chunks** — stdout is a stream; in
   production we've seen the start marker arrive in one `data` event
   and the end marker in the next. The parser uses `parseBuffer +=
chunk` with `indexOf` so it should handle this — but no test
   currently verifies that. Adding `it('handles marker split across
chunks')` (this PR).

2. **Multiple markers in one chunk** — agent-runner emits one marker
   per assistant turn; long sessions emit many. `while (startIdx =
parseBuffer.indexOf(...))` loop should drain all of them, but no
   test asserts that an `onOutput` is called twice when two markers
   arrive in one chunk. Adding (this PR).

3. **Bad JSON between markers** — parser logs and continues; no test
   pins the "log + continue, don't crash" invariant. Adding (this PR).

4. **MAX_OUTPUT_SIZE truncation** — `stdoutTruncated` flag and
   `stderrTruncated` are set when overflowing, but no test exercises
   the truncation boundary. Lower priority (truncation is
   defense-in-depth, not a path that has caused incidents).

### `src/ghc-session-recovery.test.ts` (~14 tests, 163 lines)

**Verdict**: KEEP, this is one of the better tests in the suite. It
combines static guards (regex on `index.ts` source) + unit tests on
`isSessionNotFoundError`. Each guard ties to a named regression (the
2026-04-23 "Session not found" cascade). Pattern worth replicating
elsewhere where we have hard-won fixes.

Possible addition: a guard ensuring layer 2's `catch` block does NOT
swallow non-`Session not found` errors. Today the catch invokes
`isSessionNotFoundError(sendErr)` to decide — but a future refactor
could accidentally make that broader (e.g. catching all errors and
retrying). A negative regex guard would catch that drift. Adding (this
PR).

### `container/agent-runner-ghc/src/load-plugin-agents.test.ts` (200 lines)

**Verdict**: KEEP, well-shaped — frontmatter parsing edge cases,
sanitization (security), tool-list parsing variants. Each test maps to
a concrete mis-parse that would corrupt agent loading.

### `container/agent-runner-ghc/src/` — coverage gap

**Verdict**: GAP. Only `load-plugin-agents` has a unit test. Missing:

- `session-recovery.ts` — actually only 23 lines and the predicate is
  unit-tested by the host-side `ghc-session-recovery.test.ts`. OK as is.
- `index.ts` (782 lines) — no unit test. This is a long-running event
  loop, hard to unit-test directly. Better covered by e2e (see below)
  than by mocking the SDK.
- `mcp-tools/*` — no tests. Lower priority — these are tool exposure
  bridges, integration is more meaningful than unit. Punt for now.

### `test/e2e/context-retention.test.ts` (483 lines)

**Verdict**: KEEP, but **scope gap**. Tests `runHostAgent` directly
(host mode). Does NOT exercise `runContainerAgent` (the v2 default
path). v2 dispatcher → IPC → container → agent-runner-ghc →
GHC SDK chain has no e2e coverage at all.

Adding: `test/e2e/v2-container-smoke.test.ts` — runs a single prompt
through the real v2 container path against free GHC model
(claude-sonnet-4 or gpt-5.4), gated on `GITHUB_TOKEN` and
`NANOCLAW_E2E_CONTAINER=1` so it doesn't run by default in unit
sweep. Workspace isolated via `NANOCLAW_WORKSPACE=$(mktemp -d)`.

## What I am NOT doing

- Not deleting any existing tests this round. Audit-then-prune is two
  separate cycles; this round is audit + targeted gap-fill only.
- Not refactoring mock-heavy tests (`container-runner.test.ts` has a
  ~70-line mock setup) — would need bigger redesign discussion.
- Not touching VM's lane (modules/, dispatcher/, ipc-extensions,
  workspace-config, etc.) — VM is auditing those.

## Status

- [x] Baseline `npm test`: 1142/1142 green (95 files)
- [x] Audit + findings doc (this file)
- [ ] Add 3 container-runner tests (split marker, multi marker, bad JSON)
- [ ] Add 1 ghc-session-recovery negative guard
- [ ] Add v2 container e2e smoke test (gated)
- [ ] Re-run full suite, confirm no regression

PR: TBD
