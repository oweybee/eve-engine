#!/usr/bin/env bash
# Wrapper: load .env and run the GitHub schedule watchdog from the repo root.
set -euo pipefail

# repo root = two levels up from this script (scripts/gh-watchdog/run.sh)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="scripts/gh-watchdog/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

exec node scripts/gh-watchdog/ghWatchdog.js "$@"
