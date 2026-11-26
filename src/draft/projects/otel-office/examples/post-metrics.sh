#!/usr/bin/env bash
# POST the sample OTLP/JSON metrics to a running otel-office server.
# Usage: examples/post-metrics.sh [port]
set -euo pipefail
PORT="${1:-${PORT:-8080}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -sS -X POST "http://localhost:${PORT}/v1/metrics" \
  -H 'content-type: application/json' \
  --data-binary "@${HERE}/sample-metrics.json"
echo
