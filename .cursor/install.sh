#!/usr/bin/env bash
# Idempotent Cursor Cloud Agent bootstrap (see .cursor/environment.json). No secrets; no daemons.
set -euo pipefail

if ! bash scripts/bootstrap-dev.sh --skip-dotfiles; then
	printf '%s\n' "bootstrap-dev failed; fix mise/network then rerun"
fi

# Grok subscription auth lives in Hobo-Labs/dotfiles; optional local helper when seed is linked.
if command -v hobo-grok-auth >/dev/null 2>&1; then
	hobo-grok-auth || printf '%s\n' "grok subscription auth skipped"
elif [ -x contrib/hobo-dotfiles-seed/scripts/grok-auth.sh ]; then
	bash contrib/hobo-dotfiles-seed/scripts/grok-auth.sh || true
fi

command -v grok >/dev/null 2>&1 && grok --version || printf '%s\n' "grok: not on PATH"

if ! pnpm run install:check; then
	printf '%s\n' "dependency install failed; rerun inside the agent"
fi
