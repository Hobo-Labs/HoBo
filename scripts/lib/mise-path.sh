#!/usr/bin/env bash
# Shared mise install + PATH for HoBo bootstrap scripts. Source, do not execute.
set -euo pipefail

mise_ensure_installed() {
	if command -v mise >/dev/null 2>&1; then
		return 0
	fi
	local installer="${MISE_INSTALL_URL:-https://mise.run}"
	# The installer downloads the release and its checksum itself, without
	# retries; one reset connection on a hosted runner fails the whole job.
	# Retry the whole install, a few times with back-off.
	local attempt=1 attempts="${MISE_INSTALL_ATTEMPTS:-4}" delay="${MISE_INSTALL_RETRY_DELAY:-2}"
	until curl -fsSL --retry 3 --retry-all-errors "$installer" | sh; do
		if ((attempt >= attempts)); then
			echo "mise: install failed after ${attempts} attempts" >&2
			return 1
		fi
		echo "mise: install attempt ${attempt} failed; retrying in ${delay}s" >&2
		sleep "$delay"
		attempt=$((attempt + 1))
		delay=$((delay * 2))
	done
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
