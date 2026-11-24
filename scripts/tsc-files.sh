#!/usr/bin/env bash
# Type-check the whole project but print only errors in files matching the
# given extended regex (paths relative to the repo root). Useful while other
# areas are mid-rewrite. Example: scripts/tsc-files.sh '^src/server/routers/(project|document)'
set -uo pipefail
pattern="${1:?usage: scripts/tsc-files.sh <path-regex>}"
out=$(npx tsc --noEmit -p tsconfig.json 2>&1)
matches=$(printf '%s\n' "$out" | grep -E "$pattern" | grep "error TS" || true)
count=$(printf '%s' "$matches" | grep -c "error TS" || true)
printf '%s\n' "$matches"
echo "errors in matching files: $count (project total: $(printf '%s\n' "$out" | grep -c 'error TS'))"
