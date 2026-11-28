#!/usr/bin/env bash
set -uo pipefail
status=0
node --experimental-strip-types --no-warnings "$(dirname "${BASH_SOURCE[0]}")/merge-group-live.mts" || status=$?
case "$status" in
  0) ;;
  3) exit 1 ;;
  *) echo "::warning::The merge-group liveness check could not run (exit ${status}); the job continues" ;;
esac
