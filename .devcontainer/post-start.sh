#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node --import tsx packages/ci-gh-actions/scripts/local-runner.ts start
