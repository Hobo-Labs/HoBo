#!/usr/bin/env bash
set -euo pipefail

if ! command -v gbrain >/dev/null 2>&1; then
  cat >&2 <<'EOF'
gbrain MCP: binary not on PATH.

Zero-key default (recommended): decline the gbrain MCP server in your agent UI, or never enable it.
  bash scripts/setup-agent-tools.sh --common-only --no-gbrain

To enable later: install Bun, re-run setup without --no-gbrain, then `gbrain init`.
Keys + data egress: AUTH.md  |  docs/agent-tooling.md
EOF
  exit 1
fi

gbrain_config="${GBRAIN_HOME:-$HOME/.gbrain}/config.json"
if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${ZEROENTROPY_API_KEY:-}" ] && [ -z "${VOYAGE_API_KEY:-}" ] \
  && ! grep -Eq '"embedding_model"[[:space:]]*:[[:space:]]*"ollama:' "$gbrain_config" 2>/dev/null; then
  cat >&2 <<'EOF'
gbrain MCP: no embedding provider configured.

Run `gbrain init --pglite` and select local Ollama (no key). gbrain also reads one of
OPENAI_API_KEY | ZEROENTROPY_API_KEY | VOYAGE_API_KEY from its own environment, but agents
never store a key in an environment variable or a .env file (AGENTS.md). Remote providers
receive embedding and query text (cost + egress).

Or decline this MCP server to keep gbrain disabled. See AUTH.md.
EOF
  exit 1
fi

exec gbrain serve "$@"
