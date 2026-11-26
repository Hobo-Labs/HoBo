#!/usr/bin/env bash
set -euo pipefail

if ! command -v headroom >/dev/null 2>&1; then
  cat >&2 <<'EOF'
headroom MCP: binary not on PATH.

Install the common zero-key layer:
  bash scripts/setup-agent-tools.sh --common-only --no-gbrain

Ensure $HOME/.local/bin is on PATH. No API keys. Narrative: docs/agent-tooling.md
EOF
  exit 1
fi

exec headroom mcp serve "$@"
