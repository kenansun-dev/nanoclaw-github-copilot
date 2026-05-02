#!/usr/bin/env bash
# Scenario 01: `tui --ask` does not leak docker containers
# Catches: regression of the P1 bug fixed in d3109c2/c9fe7d8 — sandbox
#          path failing to write _close sentinel + container hanging
#          ~30 min until CONTAINER_TIMEOUT.
# Runtime: ~20s

set -uo pipefail
ws="$CONFIDENCE_WORKSPACE"
mkdir -p "$ws"
export NANOCLAW_WORKSPACE="$ws"

if ! command -v docker >/dev/null 2>&1; then
  echo "skip: docker not on PATH" >&2
  exit 2
fi

# Snapshot orphan candidates before run (other tests / installs may also
# have nanoclaw-* containers; we only count *new* ones)
before=$(docker ps -a --filter "name=nanoclaw-tui-ask" --format "{{.ID}}" | sort)

start_ts=$(date +%s)
node "$NANOCLAW_BIN" tui --ask "say PONG and exit" > /tmp/sc01.out 2>&1
rc=$?
dur=$(( $(date +%s) - start_ts ))

after=$(docker ps -a --filter "name=nanoclaw-tui-ask" --format "{{.ID}}" | sort)
new_orphans=$(comm -13 <(echo "$before") <(echo "$after") | wc -l | tr -d ' ')

# Cleanup any new orphans so test is idempotent
comm -13 <(echo "$before") <(echo "$after") | xargs -r docker rm -f >/dev/null 2>&1 || true

echo "RESULT: duration_s=$dur"
echo "RESULT: cli_exit=$rc"
echo "RESULT: new_orphans=$new_orphans"

# Pass criteria:
# - CLI exited cleanly (0)
# - took less than 60s (real result is ~15s; 60s budget catches the
#   bug where it hangs for QUERY_TIMEOUT_MS = 5min)
# - left zero new orphan containers
[[ $rc -eq 0 ]] || { echo "fail: cli exit $rc" >&2; cat /tmp/sc01.out >&2; exit 1; }
[[ $dur -lt 60 ]] || { echo "fail: hung for ${dur}s (budget 60s)" >&2; exit 1; }
[[ $new_orphans -eq 0 ]] || { echo "fail: $new_orphans orphan containers" >&2; exit 1; }
exit 0
