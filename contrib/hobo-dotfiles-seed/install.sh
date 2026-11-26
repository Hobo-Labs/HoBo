#!/usr/bin/env bash
# Idempotent dotfiles install for HoBo developers and cloud agents.
set -euo pipefail

DOTFILES_ROOT="$(cd "$(dirname "$0")" && pwd)"

mise_ensure() {
	if command -v mise >/dev/null 2>&1; then
		return 0
	fi
	curl -fsSL "${MISE_INSTALL_URL:-https://mise.run}" | sh
	export PATH="${HOME}/.local/bin:${PATH}"
}

link_path() {
	local src="$1"
	local dest="$2"
	mkdir -p "$(dirname "$dest")"
	if [ -e "$dest" ] && [ ! -L "$dest" ]; then
		echo "skip link (exists, not symlink): $dest"
		return 0
	fi
	ln -snf "$src" "$dest"
	echo "linked $dest -> $src"
}

mise_ensure
export PATH="${HOME}/.local/bin:${PATH}"

if [ -f "${DOTFILES_ROOT}/mise.toml" ]; then
	mise trust "${DOTFILES_ROOT}/mise.toml" 2>/dev/null || mise trust -a 2>/dev/null || true
	MISE_CONFIG_DIR="${DOTFILES_ROOT}" mise install
fi

# Shell: mise activation (append once)
for rc in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
	[ -f "$rc" ] || continue
	if ! grep -q 'mise activate' "$rc" 2>/dev/null; then
		{
			echo ''
			echo '# HoBo dotfiles: mise'
			echo 'export PATH="$HOME/.local/bin:$PATH"'
			echo 'command -v mise >/dev/null 2>&1 && eval "$(mise activate bash)"'
		} >>"$rc"
		echo "appended mise hook to $rc"
	fi
done

# Git defaults (non-destructive; does not set user.name/email)
git config --global init.defaultBranch main 2>/dev/null || true

# Agent auth helpers
if [ -f "${DOTFILES_ROOT}/scripts/grok-auth.sh" ]; then
	link_path "${DOTFILES_ROOT}/scripts/grok-auth.sh" "${HOME}/.local/bin/hobo-grok-auth"
fi

# HoBo repo hook: refresh project tools when install runs from a checkout
if [ -n "${HOBO_REPO_ROOT:-}" ] && [ -f "${HOBO_REPO_ROOT}/mise.toml" ]; then
	mise trust "${HOBO_REPO_ROOT}/mise.toml" 2>/dev/null || true
	(
		cd "${HOBO_REPO_ROOT}"
		mise install
	)
fi

echo "dotfiles install: complete"
