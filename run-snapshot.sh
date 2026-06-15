#!/bin/bash
# Max Edge — snapshot runner for launchd. Sources .env then captures a cycle.
# Logs to engine/snapshot.log so you can tail it; gradeResults runs too but
# no-ops cleanly until ODDS_API_KEY is set.
cd "/Users/owenburrows/Downloads/eve-project FINAL/engine" || exit 1
export PATH="/usr/local/bin:/usr/bin:/bin"
set -a
[ -f .env ] && . ./.env
set +a

echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="
/usr/local/bin/node captureSnapshot.js
# Grade finished matches when a results key is configured
if [ -n "$ODDS_API_KEY" ]; then
  /usr/local/bin/node gradeResults.js
fi
