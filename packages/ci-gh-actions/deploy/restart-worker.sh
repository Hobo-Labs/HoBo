#!/usr/bin/env bash
# Graceful box-worker restart: drain in-flight hobo / merge-queue containers before exit.
set -euo pipefail

export HOBO_CI_WORKER_STOP_MODE="${HOBO_CI_WORKER_STOP_MODE:-drain}"

export HOBO_CI_WORKER_DRAIN_TIMEOUT_MS="${HOBO_CI_WORKER_DRAIN_TIMEOUT_MS:-7200000}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/../../.." && pwd)"
daemon="$repo_root/packages/ci-gh-actions/scripts/isolated-worker-daemon.mts"

if [[ ! -f "$daemon" ]]; then
	echo "isolated worker daemon entry not found: $daemon" >&2
	exit 1
fi

match_pids() {
	pgrep -af "isolated-worker-daemon\\.mts" 2>/dev/null || true
}

pids="$(match_pids | awk '{print $1}' | sort -u || true)"
if [[ -z "$pids" ]]; then
	echo "no isolated worker daemon process found" >&2
	exit 1
fi

echo "signaling drain stop (HOBO_CI_WORKER_STOP_MODE=$HOBO_CI_WORKER_STOP_MODE, timeout=${HOBO_CI_WORKER_DRAIN_TIMEOUT_MS}ms)"
for pid in $pids; do
	kill -TERM "$pid" 2>/dev/null || true
done

deadline=$((SECONDS + HOBO_CI_WORKER_DRAIN_TIMEOUT_MS / 1000))
while (( SECONDS < deadline )); do
	remaining="$(match_pids | wc -l | tr -d ' ')"
	if [[ "$remaining" -eq 0 ]]; then
		echo "worker drained and exited"
		exit 0
	fi
	sleep 5
done

echo "timed out waiting for worker drain; ${remaining:-?} process(es) still running" >&2
exit 1
