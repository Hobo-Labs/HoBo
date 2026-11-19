#!/usr/bin/env sh
unset $(git rev-parse --local-env-vars 2>/dev/null)
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
git config --get core.hooksPath >/dev/null 2>&1 && exit 0
common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
[ -n "$common" ] || exit 0
git config --file "$common/config" core.hooksPath .githooks >/dev/null 2>&1
exit 0
