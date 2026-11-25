#!/usr/bin/env bash
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
