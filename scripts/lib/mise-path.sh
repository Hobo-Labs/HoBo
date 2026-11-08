#!/usr/bin/env bash
# Shared mise install + PATH for HoBo bootstrap scripts. Source, do not execute.
set -euo pipefail

mise_ensure_installed() {
	if command -v mise >/dev/null 2>&1; then
		return 0
	fi
	local installer="${MISE_INSTALL_URL:-https://mise.run}"
	curl -fsSL "$installer" | sh
}

mise_ensure_on_path() {
	mise_ensure_installed
	export PATH="${HOME}/.local/bin:${PATH}"
}

mise_trust_hobo_root() {
	local root="${1:-.}"
	if [[ -f "${root}/mise.toml" ]]; then
		mise trust "${root}/mise.toml" 2>/dev/null || mise trust -a 2>/dev/null || true
	fi
}

mise_install_project_tools() {
	local root="${1:-.}"
	(
		cd "$root"
		mise_trust_hobo_root "$root"
		mise install
	)
}
