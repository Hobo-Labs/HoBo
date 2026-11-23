#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v serena >/dev/null 2>&1; then
  cat >&2 <<'EOF'
serena MCP: binary not on PATH.

Install the common zero-key layer:
  bash scripts/setup-agent-tools.sh --common-only --no-gbrain

Ensure $HOME/.local/bin is on PATH. Narrative: docs/agent-tooling.md · table: AGENTS.md
EOF
  exit 1
fi

exec serena start-mcp-server --project "$repo_root" "$@"
