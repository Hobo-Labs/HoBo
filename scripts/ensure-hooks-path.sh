#!/usr/bin/env sh
for variable in $(git rev-parse --local-env-vars 2>/dev/null); do
	unset "$variable"
done
cd "$(dirname "$0")/.." 2>/dev/null || exit 0
for flag in "${HOBO_SKIP_HOOKS:-}" "${CI:-}"; do
	case $(printf '%s' "$flag" | tr '[:upper:]' '[:lower:]') in
	1 | true | yes | on) exit 0 ;;
	esac
done
[ -d .githooks ] || exit 0
[ -e .git ] || exit 0
top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0
[ "$(cd "$top" 2>/dev/null && pwd -P)" = "$(pwd -P)" ] || exit 0
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -n "$common" ] || exit 0
git config --get core.hooksPath >/dev/null 2>&1 ||
	git config --file "$common/config" core.hooksPath .githooks >/dev/null 2>&1
merge_driver() {
	git config --file "$common/config" "merge.$1.name" "$2" >/dev/null 2>&1
	git config --file "$common/config" "merge.$1.driver" "node --experimental-strip-types --no-warnings scripts/ci/merge-driver.mts $3 %O %A %B %P" >/dev/null 2>&1
}
merge_driver hobo-attestation-pins "HoBo attestation pins recomputed from the merged workflow and plan" pins
merge_driver hobo-error-catalog "HoBo CI error catalog regenerated from the merged sources" catalog
exit 0
