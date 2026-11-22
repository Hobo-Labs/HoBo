#!/usr/bin/env bash
set -u -o pipefail

skill_dir="$(cd "${1:?pass a verification skill directory}" && pwd)"
repo_dir="$(git -C "$skill_dir" rev-parse --show-toplevel)"
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/hobo-state-check.XXXXXX")"
trap 'rm -rf -- "$scratch_dir"' EXIT
java_tmpdir="${scratch_dir//\'/\'\"\'\"\'}"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djava.io.tmpdir='$java_tmpdir'"

# TLC extracts standard modules into java.io.tmpdir. Give every runner its own
# directory so concurrent checks cannot overwrite each other's module files.
# JAVA_TOOL_OPTIONS accepts adjacent quoted fragments, including for apostrophes.
java_tmpdir="${scratch_dir//\'/\'\"\'\"\'}"
export JAVA_TOOL_OPTIONS="${JAVA_TOOL_OPTIONS:+$JAVA_TOOL_OPTIONS }-Djava.io.tmpdir='$java_tmpdir'"

jar="${TLA2TOOLS:-$scratch_dir/tla2tools.jar}"
if [[ -z "${TLA2TOOLS:-}" ]]; then
	if ! curl -fsSL --retry 2 --max-time 60 \
		'https://github.com/tlaplus/tlaplus/releases/download/v1.7.4/tla2tools.jar' \
		-o "$jar"; then
		echo 'Unable to download TLC 1.7.4; set TLA2TOOLS to its jar.' >&2
		exit 2
	fi
fi
if [[ ! -f "$jar" ]]; then
	echo "TLC jar not found: $jar" >&2
	exit 2
fi
jar="$(cd "$(dirname "$jar")" && pwd)/$(basename "$jar")"
if ! printf '%s  %s\n' \
	'936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88' \
	"$jar" | sha256sum -c --status; then
	echo 'TLC jar checksum does not match version 1.7.4.' >&2
	exit 2
fi

export TLA2TOOLS="$jar"

shopt -s nullglob
tests=("$skill_dir"/tests/*.mts)
models=("$skill_dir"/models/*.tla)
if (( ${#tests[@]} == 0 || ${#models[@]} == 0 )); then
	echo 'The skill must contain real-code tests and TLA+ models.' >&2
	exit 2
fi

result=0
for test_file in "${tests[@]}"; do
	printf '\nExecutable check: %s\n' "$(basename "$test_file")"
	(cd "$repo_dir" && node --disable-warning=ExperimentalWarning --import tsx "$test_file") || result=1
done
for model_file in "${models[@]}"; do
	model="$(basename "$model_file" .tla)"
	config_file="$skill_dir/models/$model.cfg"
	if [[ ! -f "$config_file" ]]; then
		echo "Missing config for $model" >&2
		result=1
		continue
	fi
	cp "$model_file" "$config_file" "$scratch_dir/"
	printf '\nModel check: %s\n' "$model"
	(cd "$scratch_dir" && java -XX:+UseParallelGC -cp "$jar" tlc2.TLC \
		-workers 1 -fp 0 -lncheck final -config "$model.cfg" "$model.tla") || result=1
done
exit "$result"
