#!/usr/bin/env bash
# MaxEdge in-play worker — tight loop for live signal cadence.
#
# GitHub Actions throttles the run-inplay schedule to every few hours, far too
# slow to react to a goal. This runs the same three steps on a short interval on
# an always-on host instead. Each step is idempotent and self-gating, so a fast
# interval is cheap when nothing is live (one /fixtures?live=all poll per tick).
set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1          # repo root

# Load env (SUPABASE_*, API_FOOTBALL_KEY, TELEGRAM_*, INPLAY_WINPROB_ENABLED …)
if [ -f scripts/inplay-vps/.env ]; then
  set -a; . scripts/inplay-vps/.env; set +a
fi

INTERVAL="${INPLAY_INTERVAL_SEC:-30}"
echo "[inplay-worker] starting — interval ${INTERVAL}s, winprob=${INPLAY_WINPROB_ENABLED:-false}"

while true; do
  START=$(date +%s)
  node ingestLiveOdds.js      || echo "[inplay-worker] ingest step failed (continuing)"
  node computeInplayValues.js || echo "[inplay-worker] compute step failed (continuing)"
  node postToX.js             || echo "[inplay-worker] post step failed (continuing)"
  ELAPSED=$(( $(date +%s) - START ))
  SLEEP=$(( INTERVAL - ELAPSED ))
  [ "$SLEEP" -lt 1 ] && SLEEP=1
  sleep "$SLEEP"
done
