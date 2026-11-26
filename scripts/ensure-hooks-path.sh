#!/usr/bin/env sh
# Point git at this repository's hooks (.githooks) when nothing else has.
#
# The root `prepare` script does this on install, but an install that runs no
# lifecycle scripts, or a worktree sharing another checkout's node_modules,
# never runs it, and `git commit` is then ungated. Each agent's session-start
# hook calls this script (.claude/settings.json, .codex/hooks.json,
# .cursor/hooks.json, .github/hooks/git-hooks-path.json).
#
# It writes core.hooksPath into the common git config, which every worktree
# shares, and only when no value is in effect, so it never replaces one
# somebody chose. It acts only on this checkout's own repository: a copy with
# no .git of its own, inside some other repository, leaves that one alone. It
# prints nothing and always exits 0, so a session never fails because of it.
# HOBO_SKIP_HOOKS or CI set to 1, true, yes or on skips it, as they skip
# scripts/install-hooks.mts.
#
# Git's repository variables (GIT_DIR, GIT_COMMON_DIR, GIT_WORK_TREE, …) are
# dropped first: git exports an absolute GIT_DIR to hooks in a linked
# worktree, and an inherited one would send the write to that repository. The
# pre-commit hook must not do the same; its gates read git's temporary index.
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
