#!/usr/bin/env bash
set -u -o pipefail

FORMAL_SKILL_TIMEOUT_SEC="${FORMAL_SKILL_TIMEOUT_SEC:-1500}"

repo_dir="$(git rev-parse --show-toplevel)"
cd "$repo_dir" || exit 2

list_only=false
shard_index=0
shard_count=1
shard_seen=false
jobs=1
jobs_seen=false
while (( $# > 0 )); do
	case "$1" in
		--) shift ;;
		--list) list_only=true; shift ;;
		--shard=*)
			if [[ "$shard_seen" == true || ! "${1#--shard=}" =~ ^(0|[1-9][0-9]?)/([1-9][0-9]?)$ ]]; then
				echo 'Shard must be a single zero-based INDEX/COUNT.' >&2
				exit 2
			fi
			shard_index="${BASH_REMATCH[1]}"
			shard_count="${BASH_REMATCH[2]}"
			if (( shard_index >= shard_count )); then
				echo 'Shard index must be less than its count.' >&2
				exit 2
			fi
			shard_seen=true
			shift ;;
		--jobs=*)
			if [[ "$jobs_seen" == true || ! "${1#--jobs=}" =~ ^[1-9][0-9]?$ ]]; then
				echo 'Jobs must be a single count from 1 to 99.' >&2
				exit 2
			fi
			jobs="${1#--jobs=}"
			jobs_seen=true
			shift ;;
		--*) echo "Unknown verification option: $1" >&2; exit 2 ;;
		*) break ;;
	esac
done

shopt -s nullglob
if (( $# == 0 )); then
	skills=("$repo_dir"/.agents/skills/verify-*)
else
	skills=()
	for name in "$@"; do
		if [[ ! "$name" =~ ^verify-[a-z0-9-]+$ || ! -d "$repo_dir/.agents/skills/$name" ]]; then
			echo "Unknown verification skill: $name" >&2
			exit 2
		fi
		skills+=("$repo_dir/.agents/skills/$name")
	done
fi
if (( ${#skills[@]} > 0 )); then
	mapfile -t skills < <(printf '%s\n' "${skills[@]}" | LC_ALL=C sort -u)
fi
if (( ${#skills[@]} == 0 )); then
	echo 'No state-machine verification skills found.' >&2
	exit 2
fi

selected=()
for index in "${!skills[@]}"; do
	if (( index % shard_count == shard_index )); then
		selected+=("${skills[index]}")
	fi
done
skills=("${selected[@]}")
if [[ "$list_only" == true ]]; then
	for skill in "${skills[@]}"; do printf '%s\n' "${skill##*/}"; done
	exit 0
fi
if (( ${#skills[@]} == 0 )); then
	echo 'No state-machine verification skills assigned to this shard.'
	exit 0
fi

scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/hobo-all-state-checks.XXXXXX")"
trap 'rm -rf -- "$scratch_dir"' EXIT

if [[ -z "${TLA2TOOLS:-}" ]]; then
	TLA2TOOLS="$scratch_dir/tla2tools.jar"
	if ! curl -fsSL --retry 2 --max-time 60 \
		'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar' \
		-o "$TLA2TOOLS"; then
		echo 'Unable to download TLC 1.7.4; set TLA2TOOLS to its jar.' >&2
		exit 2
	fi
fi
if [[ ! -f "$TLA2TOOLS" ]] || ! printf '%s  %s\n' \
	'936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88' \
	"$TLA2TOOLS" | sha256sum -c --status; then
	echo 'TLA2TOOLS must be the checksum-pinned TLC 1.7.4 jar.' >&2
	exit 2
fi
export TLA2TOOLS

needs_z3=false
for skill in "${skills[@]}"; do
	[[ -f "$skill/tests/proof.mts" ]] && needs_z3=true
done
if [[ "$needs_z3" == true ]]; then
	if [[ -n "${BUDGET_Z3_PYTHONPATH:-}" ]]; then
		if ! PYTHONPATH="$BUDGET_Z3_PYTHONPATH" python3 -c $'import sys, z3\nversion = z3.get_version_string()\nif version != "4.15.4":\n\tprint(f"Z3 4.15.4 is required; found {version}.", file=sys.stderr)\n\tsys.exit(1)'; then
			echo 'BUDGET_Z3_PYTHONPATH must contain z3-solver 4.15.4.0.' >&2
			exit 2
		fi
	elif ! python3 -c $'import sys, z3\nversion = z3.get_version_string()\nif version != "4.15.4":\n\tprint(f"Z3 4.15.4 is required; found {version}.", file=sys.stderr)\n\tsys.exit(1)' 2>/dev/null; then
		if ! python3 -m pip install --disable-pip-version-check --no-cache-dir --no-deps \
			--require-hashes --only-binary=:all: --target "$scratch_dir/python" \
			-r "$repo_dir/.agents/skills/verify-broker-budget-authority/proof/requirements-z3.txt"; then
			echo 'Unable to install hash-pinned Z3; set BUDGET_Z3_PYTHONPATH.' >&2
			exit 2
		fi
		BUDGET_Z3_PYTHONPATH="$scratch_dir/python"
		export BUDGET_Z3_PYTHONPATH
	fi
fi

run_skill() {
	local skill="$1" name="${1##*/}" started="$SECONDS" status=0
	timeout --kill-after=60s --signal=TERM "$FORMAL_SKILL_TIMEOUT_SEC" \
		bash scripts/verify-state-machine.sh "$skill" >"$scratch_dir/$name.log" 2>&1 || status=$?
	printf '%s %s\n' "$status" "$((SECONDS - started))" >"$scratch_dir/$name.result"
}

running=0
for skill in "${skills[@]}"; do
	if (( running >= jobs )); then
		wait -n
		running=$((running - 1))
	fi
	run_skill "$skill" &
	running=$((running + 1))
done
wait

failed=0
for skill in "${skills[@]}"; do
	name="${skill##*/}"
	status=1
	seconds=0
	read -r status seconds 2>/dev/null <"$scratch_dir/$name.result"
	if [[ "$status" == 0 ]]; then
		printf 'PASS %s (%ss)\n' "$name" "$seconds"
	else
		printf 'FAIL %s (%ss)\n' "$name" "$seconds" >&2
		cat "$scratch_dir/$name.log" >&2
		failed=$((failed + 1))
	fi
done
printf 'Checked %s skills with %s jobs in %ss; %s failed.\n' "${#skills[@]}" "$jobs" "$SECONDS" "$failed"
(( failed == 0 ))
