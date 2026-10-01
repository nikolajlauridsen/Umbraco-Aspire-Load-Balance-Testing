#!/usr/bin/env bash
# Runs only the sync-gap probe against the running rig and writes <run-dir>/probe.txt, as run-scenario.sh does.
# Usage: scripts/run-probe.sh <run-dir>
set -uo pipefail
OUT="${1:?usage: run-probe.sh <run-dir>}"
cd "$(dirname "$0")/.."
mkdir -p "$OUT"
status=0
{
  echo "## delayMs=3000"; scripts/repro-sync-gap.sh 5 3000 || status=$?
  echo "## delayMs=0"; scripts/repro-sync-gap.sh 4 0 || status=$?
} > "$OUT/probe.txt" 2>&1
cat "$OUT/probe.txt"
exit $status
