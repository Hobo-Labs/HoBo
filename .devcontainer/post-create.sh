#!/usr/bin/env bash
# Devcontainer bootstrap: mise project tools, deps, CI act shim, common agent helpers.
set -euo pipefail
cd "$(dirname "$0")/.."

export PATH="${HOME}/.local/bin:${PATH}"
bash scripts/bootstrap-dev.sh

eval "$(mise activate bash)" 2>/dev/null || true

mkdir -p .tools/ci
pnpm install --frozen-lockfile --config.confirmModulesPurge=false
pnpm exec turbo run build --filter=@hobo/ci-gh-actions --concurrency=100%
node --import tsx packages/ci-gh-actions/scripts/act-install.ts --directory .tools/ci
bash scripts/setup-agent-tools.sh --common-only --no-gbrain
