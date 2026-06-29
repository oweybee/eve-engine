#!/usr/bin/env bash
# Wrapper: load .env and run the Betfair ingest from the repo root.
set -euo pipefail

# repo root = two levels up from this script (scripts/betfair-vps/run.sh)
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="scripts/betfair-vps/.env"
if [ -f "$ENV_FILE" ]; then
  set -a; . "$ENV_FILE"; set +a
fi

exec node betfairIngest.js
