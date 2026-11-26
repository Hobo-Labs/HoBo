#!/usr/bin/env bash
# POST the sample OTLP/JSON logs to a running otel-office server.
# Usage: examples/post-logs.sh [port]
set -euo pipefail
PORT="${1:-${PORT:-8080}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -sS -X POST "http://localhost:${PORT}/v1/logs" \
  -H 'content-type: application/json' \
  --data-binary "@${HERE}/sample-logs.json"
echo
