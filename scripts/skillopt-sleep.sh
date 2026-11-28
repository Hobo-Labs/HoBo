#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cmd="${1:-status}"
if [ "$#" -gt 0 ]; then shift; fi
exec python3 -m skillopt_sleep "$cmd" --project "$repo_root" "$@"
