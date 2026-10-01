#!/usr/bin/env bash
# Probes the window between a writer's cache version bump (committed with the save) and its cache
# instruction (written at request end). If another node runs an inline isolated-cache sync inside that
# window, it adopts the new version without seeing the instruction and then serves its stale cached copy
# until the background instruction job catches up.
#
# Usage: scripts/repro-sync-gap.sh [rounds] [delayMs]
#   Needs the rig running with at least two nodes and a seeded tree (POST /umbraco/lb/seed).
set -euo pipefail
ROUNDS="${1:-5}"
DELAY_MS="${2:-3000}"
A=http://localhost:5001   # writer
B=http://localhost:5002   # reader

fetch() {
  local body
  if ! body=$(curl -sf "$1"); then
    echo "ERROR: GET $1 failed: $(curl -s "$1" | head -c 300)" >&2
    exit 1
  fi
  echo "$body"
}

ids=$(fetch "$A/umbraco/lb/ids?count=40" | python3 -c "import json,sys; print(' '.join(map(str, json.load(sys.stdin)['ids'])))")
read -r -a IDS <<< "$ids"

title() { fetch "$1/umbraco/lb/get/$2" | python3 -c "import json,sys; print(json.load(sys.stdin)['title'])"; }

# Waits until node B returns the same title as the database (read through node A after its own save),
# printing how long that took, or "over 120" if it never did.
converge() {
  local id=$1 expected=$2 start=$(date +%s)
  while [ "$(title "$B" "$id")" != "$expected" ]; do
    [ $(( $(date +%s) - start )) -ge 120 ] && { echo "over 120"; return; }
    sleep 0.25
  done
  echo "$(( $(date +%s) - start ))"
}

run() {
  local mode=$1 id=$2 other=$3
  sleep 7                                   # let B's background job run, so B starts fully synced
  title "$B" "$id" > /dev/null              # put the document in B's isolated cache
  curl -sf -X POST "$A/umbraco/lb/save/$id?delayMs=$DELAY_MS" > /dev/null &
  local writer=$!
  if [ "$mode" = probe ]; then
    sleep 1
    title "$B" "$other" > /dev/null         # unrelated document read on B inside the window -> inline sync
  fi
  wait $writer                              # A's request has ended: its instruction is now in the database
  local expected=$(title "$A" "$id") seen=$(title "$B" "$id")
  if [ "$seen" = "$expected" ]; then
    echo "$mode id=$id fresh"
  else
    echo "$mode id=$id STALE (B=$seen, db=$expected), B converged after $(converge "$id" "$expected")s"
  fi
}

for ((r = 0; r < ROUNDS; r++)); do
  run control "${IDS[$((r * 4))]}" "${IDS[$((r * 4 + 1))]}"
  run probe "${IDS[$((r * 4 + 2))]}" "${IDS[$((r * 4 + 3))]}"
done
