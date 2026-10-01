#!/usr/bin/env bash
# Boots the rig on one CMS version, runs a k6 script and optionally the sync-gap probe, and collects the
# results into a folder. Leaves the rig running so it can be inspected afterwards.
#
# Usage: scripts/run-scenario.sh <out-dir> <umbraco-version> [k6-script] [--probe]
#   k6-script  path inside the k6 container, default /scripts/cache-sync-lock.js
#   --probe    also run scripts/repro-sync-gap.sh 5 3000 and 4 0 after k6
#   Extra k6 knobs: export Rig__K6Env__<NAME>=<value> before calling.
#
# Writes to <out-dir>: run.log, status.json (one per node), k6.txt, node-umb-N.log, probe.txt (with --probe).
# Exit codes: 2 the rig did not come up, 3 a node runs another version than requested, 4 the probe failed.
# A run with --probe takes 10-15 minutes (the probe alone can take 5+); run it in the background.
set -uo pipefail
OUT="${1:?usage: run-scenario.sh <out-dir> <umbraco-version> [k6-script] [--probe]}"
VERSION="${2:?usage: run-scenario.sh <out-dir> <umbraco-version> [k6-script] [--probe]}"
SCRIPT="${3:-/scripts/cache-sync-lock.js}"
PROBE="${4:-}"
[ "$SCRIPT" = "--probe" ] && { SCRIPT=/scripts/cache-sync-lock.js; PROBE=--probe; }

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="$HOME/.aspire/bin:$PATH"
mkdir -p "$OUT"
OUT="$(cd "$OUT" && pwd)"
cd "$ROOT"

strip() { sed 's/\x1b\[[0-9;]*m//g'; }
log() { echo "[$(date -u +%T)] $*" | tee -a "$OUT/run.log"; }
k6state() {
  aspire describe --non-interactive --format Json 2>/dev/null \
    | python3 -c "import json,sys; print(next((r['state'] for r in json.load(sys.stdin)['resources'] if r['name'].startswith('k6')), 'missing'))"
}

# The node reports e.g. 17.8.0--rc.preview.102+6117125 for package 17.8.0--rc.preview.102.g6117125,
# and 17.7.0+d64a209 for 17.7.0.
expected_prefix() { echo "$1" | sed -E 's/\.g([0-9a-f]{7,})$/+\1/'; }

log "version=$VERSION script=$SCRIPT probe=${PROBE:-no}"
aspire stop --non-interactive >/dev/null 2>&1
UmbracoVersion="$VERSION" Rig__K6Script="$SCRIPT" \
  aspire run --detach --non-interactive --nologo --launch-profile http 2>&1 | strip | tail -3 | tee -a "$OUT/run.log"

if ! aspire wait gateway --status up --timeout 600 --non-interactive 2>&1 | strip | tail -1 | tee -a "$OUT/run.log" | grep -q "is up"; then
  log "ERROR: the gateway did not come up; node logs follow in node-*.log"
  for n in $(aspire describe --non-interactive --format Json 2>/dev/null | python3 -c "import json,sys; [print(r['displayName']) for r in json.load(sys.stdin)['resources'] if r['displayName'].startswith('umb-')]"); do
    aspire logs "$n" --non-interactive 2>&1 | strip > "$OUT/node-$n.log"
  done
  exit 2
fi

want="$(expected_prefix "$VERSION")"
port=5001
while status=$(curl -sf "http://localhost:$port/umbraco/lb/status"); do
  node=$(echo "$status" | python3 -c "import json,sys; print(json.load(sys.stdin)['node'])")
  echo "$status" > "$OUT/status-$node.json"
  got=$(echo "$status" | python3 -c "import json,sys; print(json.load(sys.stdin)['version'])")
  case "$got" in
    "$want"*) log "$node runs $got" ;;
    *) log "ERROR: $node runs $got, expected $want"; exit 3 ;;
  esac
  port=$((port + 1))
done

# InstructionProcessJob starts 60 s after boot; without it the cross-node sync under test is not running.
log "waiting 70 s for the instruction job"
sleep 70

aspire resource k6 start --non-interactive 2>&1 | strip | tail -1 | tee -a "$OUT/run.log"
for _ in $(seq 1 180); do
  s=$(k6state)
  [ "$s" = "Running" ] || [ "$s" = "Starting" ] || break
  sleep 10
done
log "k6 state: $s"

aspire logs k6 --non-interactive 2>&1 | strip | grep -vE "running \(|^\[k6\] +[a-z]+ +[\[↓✓✗]|Scanning" > "$OUT/k6.txt"
for n in $(ls "$OUT"/status-umb-*.json | sed -E 's#.*/status-(umb-[0-9]+)\.json#\1#'); do
  aspire logs "$n" --non-interactive 2>&1 | strip > "$OUT/node-$n.log"
done

if [ "$PROBE" = "--probe" ]; then
  # A node stuck in lock timeouts after k6 (pre-fix versions) keeps failing for a while; wait it out.
  log "waiting for umb-1 and umb-2 to answer again before the probe"
  for _ in $(seq 1 60); do
    curl -sf "http://localhost:5001/umbraco/lb/ids?count=1" >/dev/null \
      && curl -sf "http://localhost:5002/umbraco/lb/ids?count=1" >/dev/null && break
    sleep 5
  done
  log "sync-gap probe"
  status=0
  {
    echo "## delayMs=3000"; scripts/repro-sync-gap.sh 5 3000 || status=$?
    echo "## delayMs=0"; scripts/repro-sync-gap.sh 4 0 || status=$?
  } > "$OUT/probe.txt" 2>&1
  cat "$OUT/probe.txt" >> "$OUT/run.log"
  if [ $status -ne 0 ]; then
    log "ERROR: the probe failed (exit $status); see probe.txt. Re-run it alone with: scripts/run-probe.sh $OUT"
    exit 4
  fi
fi

log "done; the rig is still running on $VERSION (aspire stop to stop it)"
