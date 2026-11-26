#!/usr/bin/env bash
# POST a cross-camp trace pair as TWO separate OTLP requests (parent first,
# child second) to prove the server-side trace index derives the junction
# packet across requests. Usage: examples/post-cross-request.sh [port]
set -euo pipefail
PORT="${1:-${PORT:-8080}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "→ parent (api-gateway, camp-gateway)"
curl -sS -X POST "http://localhost:${PORT}/v1/traces" \
  -H 'content-type: application/json' \
  --data-binary "@${HERE}/sample-cross-request-parent.json"
echo
echo "→ child (orders-api, camp-orders, parentSpanId from the first request)"
curl -sS -X POST "http://localhost:${PORT}/v1/traces" \
  -H 'content-type: application/json' \
  --data-binary "@${HERE}/sample-cross-request-child.json"
echo
echo "→ packets now in /state:"
curl -sS "http://localhost:${PORT}/state" | grep -o '"packets":{[^}]*}[^}]*}' || true
