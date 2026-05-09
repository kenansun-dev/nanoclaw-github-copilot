# Confidence Test Suite

Long-lived integration / regression tests that build merge confidence
for `chore/2026-04-30-v2-mergeback`. Designed to outlive that PR — once
merged, this becomes the v2-mode regression suite.

## Quick start

```bash
# Run everything, print JSON report
bash test/confidence/run-all.sh

# Run one scenario (substring match on filename)
bash test/confidence/run-all.sh --filter 01

# Save report
bash test/confidence/run-all.sh --out /tmp/confidence.json
```

## Adding a scenario

Each scenario is a self-contained shell script under `scenarios/`. File
naming: `NN-short-slug.sh` where `NN` is a 2-digit ordinal.

Required behavior:

1. **Self-contained workspace**: use `$CONFIDENCE_WORKSPACE` as
   `NANOCLAW_WORKSPACE`. Never touch `~/.nanoclaw` or any v1 install.
2. **Deterministic exit code**:
   - `0` = pass
   - `1` = fail (something broke)
   - `2` = skip (with reason on stderr — e.g. "no docker on host")
   - any other = error (treated like fail)
3. **Emit metrics**: print one or more lines like
   `RESULT: <metric_name>=<value>` on stdout. The runner parses these
   into the JSON report. Use plain string values (no JSON nesting).
4. **Idempotent**: should be safe to run repeatedly without leaking
   docker containers or files.
5. **Documented header**: each script must start with a 3-line comment
   answering: (a) what it tests, (b) what failure mode it would catch,
   (c) typical runtime.

Template:

```bash
#!/usr/bin/env bash
# Scenario NN: <one-line summary>
# Catches: <regression this would fail on>
# Runtime: ~<seconds>
set -uo pipefail
ws="$CONFIDENCE_WORKSPACE"
mkdir -p "$ws"
export NANOCLAW_WORKSPACE="$ws"

# ... do work ...

echo "RESULT: orphan_count=$orphans"
[[ $orphans -eq 0 ]] || exit 1
exit 0
```

## Cadence

| Cadence | Where | Scenarios |
|---|---|---|
| nightly (cheap, < 5 min total) | `.github/workflows/confidence-nightly.yml` | #1, #5, #9, #11, #14 |
| weekly (full, can take ~1 hr) | `.github/workflows/confidence-weekly.yml` | all |
| ad-hoc | local | any subset via `--filter` |

## Reports

Weekly report committed to `docs/feat-confidence-log/YYYY-WNN-NN.md`.
Use `template.md` as starting point. Owner reads `merge-readiness
verdict` (red/yellow/green) trend to decide merge timing.

## Ownership map (initial — 2026-05-01 alignment)

| # | Scenario | Owner |
|---|---|---|
| 01 | tui --ask, no orphan containers | rpi5 |
| 02 | scheduler bridge correctness in v2 mode | rpi5 |
| 03 | container 30-min hard ceiling | rpi5 |
| 04 | MAX_CONSECUTIVE_GROUP_MISSING auto-pause | rpi5 |
| 05 | full vitest suite drift check (1184/1184) | VM |
| 06 | memory / handle leak after 100 ask cycles | rpi5 |
| 07 | OneCLI sandbox spawn-stop cleanliness | rpi5 |
| 08 | NANOCLAW_V2_DISPATCHER 0/1/2 mode parity | VM |
| 09 | upstream rebase dry-run (no conflicts) | rpi5 |
| 10 | full lifecycle init → doctor → start → stop | rpi5 |
| 11 | seedV2FromV1IfNeeded() idempotency | VM |
| 12 | install-label scoping (no cross-install kills) | rpi5 |
| 13 | C5/C7 hardening readiness (suite still green with flags on) | VM |
| 14 | nightly secrets scan over branch range | VM |
