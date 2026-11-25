#!/usr/bin/env bash
set -euo pipefail
PORT="${1:-${PORT:-8080}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -sS -X POST "http://localhost:${PORT}/v1/traces" \
  -H 'content-type: application/json' \
  --data-binary "@${HERE}/sample-trace.json"
echo
