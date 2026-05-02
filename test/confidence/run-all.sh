#!/usr/bin/env bash
# Confidence test runner.
#
# Runs all scenarios/*.sh and emits a JSON report to stdout (or a file
# via --out). Each scenario:
#   - is self-contained (sets up + tears down its own NANOCLAW_WORKSPACE)
#   - exits 0 = pass, 1 = fail, 2 = skip (with reason on stderr)
#   - prints a single-line `RESULT: <key>=<value>` to stdout for each
#     metric the scenario wants to record (parsed back into report)
#
# Usage:
#   bash test/confidence/run-all.sh                # run all, print JSON
#   bash test/confidence/run-all.sh --filter 01    # run only 01-*
#   bash test/confidence/run-all.sh --out report.json
#
# Env:
#   NANOCLAW_BIN  — path to nanoclaw entry (default: bin/nanoclaw.js
#                   relative to repo root)
#   CONFIDENCE_BASE_WORKSPACE — parent dir for scenario workspaces
#                   (default: $HOME/.nanoclaw-confidence). Each scenario
#                   creates its own subdir under here.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCENARIOS_DIR="$REPO_ROOT/test/confidence/scenarios"
NANOCLAW_BIN="${NANOCLAW_BIN:-$REPO_ROOT/bin/nanoclaw.js}"
BASE_WS="${CONFIDENCE_BASE_WORKSPACE:-$HOME/.nanoclaw-confidence}"
FILTER=""
OUT_FILE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --filter) FILTER="$2"; shift 2 ;;
    --out) OUT_FILE="$2"; shift 2 ;;
    *) echo "unknown flag: $1" >&2; exit 64 ;;
  esac
done

mkdir -p "$BASE_WS"
export NANOCLAW_BIN BASE_WS REPO_ROOT

scenarios=()
while IFS= read -r -d '' f; do
  base="$(basename "$f")"
  if [[ -n "$FILTER" && "$base" != *"$FILTER"* ]]; then continue; fi
  scenarios+=("$f")
done < <(find "$SCENARIOS_DIR" -maxdepth 1 -name '*.sh' -type f -print0 | sort -z)

if [[ ${#scenarios[@]} -eq 0 ]]; then
  echo "no scenarios matched filter='$FILTER'" >&2
  exit 64
fi

results=()
for s in "${scenarios[@]}"; do
  name="$(basename "$s" .sh)"
  start_ts=$(date +%s)
  ws="$BASE_WS/$name-$$"
  export CONFIDENCE_WORKSPACE="$ws"
  log_file="$BASE_WS/${name}.log"
  metrics_file="$BASE_WS/${name}.metrics"
  : > "$metrics_file"

  bash "$s" > >(tee "$log_file" | grep --line-buffered '^RESULT:' >> "$metrics_file") 2>&1
  rc=$?
  dur=$(( $(date +%s) - start_ts ))

  status="pass"
  if [[ $rc -eq 1 ]]; then status="fail"
  elif [[ $rc -eq 2 ]]; then status="skip"
  elif [[ $rc -ne 0 ]]; then status="error"
  fi

  metrics_json="{}"
  if [[ -s "$metrics_file" ]]; then
    metrics_json=$(awk -F'=' '
      /^RESULT:/ {
        key=$1; sub("^RESULT: *","",key); sub(/ *$/,"",key);
        val=$0; sub(/^RESULT: *[^=]+= */,"",val);
        gsub(/"/,"\\\"",val);
        printf("%s\"%s\":\"%s\"", (NR>1?",":""), key, val);
      }
      END { }
    ' "$metrics_file")
    metrics_json="{$metrics_json}"
  fi

  results+=("{\"name\":\"$name\",\"status\":\"$status\",\"rc\":$rc,\"duration_s\":$dur,\"metrics\":$metrics_json}")
  echo "[confidence] $name → $status (${dur}s, rc=$rc)" >&2

  # cleanup workspace if scenario didn't already
  rm -rf "$ws" 2>/dev/null || true
done

joined=$(IFS=,; echo "${results[*]}")
report="{\"timestamp\":\"$(date -u +%FT%TZ)\",\"branch\":\"$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD)\",\"head\":\"$(git -C "$REPO_ROOT" rev-parse HEAD)\",\"results\":[$joined]}"

if [[ -n "$OUT_FILE" ]]; then
  echo "$report" > "$OUT_FILE"
else
  echo "$report"
fi

# Exit non-zero if any scenario failed (skip/pass do not fail the run)
for r in "${results[@]}"; do
  if [[ "$r" == *'"status":"fail"'* || "$r" == *'"status":"error"'* ]]; then
    exit 1
  fi
done
exit 0
