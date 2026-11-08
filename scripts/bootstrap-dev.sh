#!/usr/bin/env bash
# Bootstrap HoBo dev tools: mise + optional dotfiles + project tool install.
# Safe for devcontainers, Cursor Cloud, Codex, and Claude Code remote (no sudo).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DOTFILES_REPO="${HOBO_DOTFILES_REPO:-https://github.com/Hobo-Labs/dotfiles.git}"
DOTFILES_REF="${HOBO_DOTFILES_REF:-main}"
SKIP_DOTFILES="${HOBO_SKIP_DOTFILES:-0}"
PROJECT_ONLY=0

usage() {
	cat <<'EOF'
Usage: bash scripts/bootstrap-dev.sh [options]

Options:
  --project-only   Skip dotfiles clone; only install mise + HoBo mise.toml tools
  --skip-dotfiles  Same as HOBO_SKIP_DOTFILES=1
  -h, --help       Show help
EOF
}

while [ "$#" -gt 0 ]; do
	case "$1" in
		-h | --help)
			usage
			exit 0
			;;
		--project-only)
			PROJECT_ONLY=1
			SKIP_DOTFILES=1
			;;
		--skip-dotfiles)
			SKIP_DOTFILES=1
			;;
		*)
			echo "unknown option: $1" >&2
			usage >&2
			exit 2
			;;
	esac
	shift
done

# shellcheck source=scripts/lib/mise-path.sh
source "$ROOT/scripts/lib/mise-path.sh"

mise_ensure_on_path

install_dotfiles() {
	if [ "$SKIP_DOTFILES" = "1" ]; then
		echo "dotfiles: skipped"
		return 0
	fi
	local dir="${HOME}/.hobo-dotfiles"
	if [ ! -d "$dir/.git" ]; then
		echo "dotfiles: cloning ${DOTFILES_REPO} (${DOTFILES_REF})"
		git clone --depth 1 --branch "$DOTFILES_REF" "$DOTFILES_REPO" "$dir" 2>/dev/null || {
			echo "dotfiles: clone failed (set HOBO_SKIP_DOTFILES=1 or publish Hobo-Labs/dotfiles)"
			return 0
		}
	else
		echo "dotfiles: pulling latest"
		git -C "$dir" fetch origin "$DOTFILES_REF" 2>/dev/null || true
		git -C "$dir" checkout "$DOTFILES_REF" 2>/dev/null || true
		git -C "$dir" pull --ff-only origin "$DOTFILES_REF" 2>/dev/null || true
	fi
	if [ -x "$dir/install.sh" ]; then
		HOBO_REPO_ROOT="$ROOT" bash "$dir/install.sh"
	else
		echo "dotfiles: no install.sh in ${dir}"
	fi
}

if [ "$PROJECT_ONLY" = "0" ]; then
	install_dotfiles
fi

echo "mise: installing project tools from ${ROOT}/mise.toml"
mise_install_project_tools "$ROOT"

if command -v mise >/dev/null 2>&1; then
	eval "$(mise activate bash)" 2>/dev/null || true
fi

echo "bootstrap-dev: done (node=$(command -v node || echo missing), pnpm=$(command -v pnpm || echo missing), cue=$(command -v cue || echo missing))"
