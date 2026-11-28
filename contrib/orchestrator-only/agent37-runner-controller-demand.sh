#!/usr/bin/env bash
set -euo pipefail

MERGE_GROUP_SCRIPTS_SHARDS="${MERGE_GROUP_SCRIPTS_SHARDS:-4}"
RESERVED_RUNNER_SLOTS_PER_BOX="${RESERVED_RUNNER_SLOTS_PER_BOX:-1}"

agent37_queue_labels() {
	printf '%s\n' hobo hobo-trunk agent37 hobo-agent37
}

agent37_count_queued_agent37_jobs() {
	gh api -H "Accept: application/vnd.github+json" \
		"/repos/Hobo-Labs/HoBo/actions/runs?status=queued&per_page=50" \
		--jq '[.workflow_runs[].id] | .[]' 2>/dev/null | while read -r run_id; do
		gh api -H "Accept: application/vnd.github+json" \
			"/repos/Hobo-Labs/HoBo/actions/runs/${run_id}/jobs?per_page=100" \
			--jq '.jobs[] | select(.status=="queued" or .status=="waiting") | .labels[]?' 2>/dev/null
	done | grep -Ec '^(agent37|hobo-agent37)$'
}

agent37_merge_group_runs_in_flight() {
	gh api -H "Accept: application/vnd.github+json" \
		"/repos/Hobo-Labs/HoBo/actions/runs?event=merge_group&status=in_progress&per_page=10" \
		--jq '[.workflow_runs[] | select(.path == ".github/workflows/hobo-ci.yml")] | length'
}

agent37_boxes_for_demand() {
	local queued="${1:-0}"
	local idle_slots="${2:-0}"
	local provisioning="${3:-0}"
	local merge_groups="${4:-0}"
	local slots="${CREATE_SLOTS:-1}"
	local effective=$((slots > RESERVED_RUNNER_SLOTS_PER_BOX ? slots - RESERVED_RUNNER_SLOTS_PER_BOX : 1))
	local supply=$((idle_slots + provisioning * slots))
	local shortfall=0
	local floor=0
	local need=0
	if ((queued > supply)); then
		shortfall=$((queued - supply))
	fi
	need=$(( (shortfall + effective - 1) / effective ))
	if ((merge_groups > 0)); then
		floor=$(( (MERGE_GROUP_SCRIPTS_SHARDS * merge_groups + slots - 1) / slots ))
	fi
	if ((need > floor)); then
		printf '%s' "${need}"
	else
		printf '%s' "${floor}"
	fi
}

agent37_council_may_use_box() {
	local busy="${1:-0}"
	local slots="${CREATE_SLOTS:-1}"
	if ((busy + RESERVED_RUNNER_SLOTS_PER_BOX > slots)); then
		return 1
	fi
	return 0
}