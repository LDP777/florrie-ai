#!/bin/bash
# Florrie load test — run this locally (not from the VM)
# Usage: bash tests/load/run.sh [prod]
#
# Without args: hits localhost:3001 (run `npm start` first)
# With "prod":  hits https://api.florrie.ai (real traffic — use sparingly)

set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ "$1" = "prod" ]; then
  echo "⚠️  Running against PRODUCTION api.florrie.ai"
  echo "   3-phase test: 2 req/sec → 10 → 20 (3.5 min total)"
  echo ""
  npx --yes artillery run "$DIR/smoke.yml" --environment production
else
  echo "Running against localhost:3001"
  echo "Start the backend first: npm start"
  echo ""
  npx --yes artillery run "$DIR/smoke.yml"
fi
