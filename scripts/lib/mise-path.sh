#!/usr/bin/env bash
set -euo pipefail

mise_ensure_installed() {
	if [[ -n "${MISE_INSTALL_PATH:-}" ]]; then
		if [[ "$MISE_INSTALL_PATH" != /* ]]; then
			echo "mise: install path must be absolute" >&2
			return 1
		fi
		if [[ -f "$MISE_INSTALL_PATH" && -x "$MISE_INSTALL_PATH" ]]; then
			return 0
		fi
	elif command -v mise >/dev/null 2>&1; then
		return 0
	fi
	local installer="${MISE_INSTALL_URL:-https://mise.run}"
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
	local install_path="${MISE_INSTALL_PATH:-${HOME}/.local/bin/mise}"
	if [[ "$install_path" != /* ]]; then
		echo "mise: install path must be absolute" >&2
		return 1
	fi
	local bin_dir="${install_path%/*}"
	if [[ -z "$bin_dir" ]]; then
		bin_dir="/"
	fi
	export PATH="${bin_dir}${PATH:+:${PATH}}"
	mise_ensure_installed || return $?
	if [[ -n "${MISE_INSTALL_PATH:-}" ]]; then
		if [[ ! -f "$install_path" || ! -x "$install_path" ]]; then
			echo "mise: installer did not create an executable at ${install_path}" >&2
			return 1
		fi
	elif ! command -v mise >/dev/null 2>&1; then
		echo "mise: installer did not provide an executable on PATH" >&2
		return 1
	fi
}

hobo_mise() {
	if [[ -n "${MISE_INSTALL_PATH:-}" ]]; then
		"$MISE_INSTALL_PATH" "$@"
	else
		mise "$@"
	fi
}

mise_trust_hobo_root() {
	local root="${1:-.}"
	if [[ -f "${root}/mise.toml" ]]; then
		hobo_mise trust "${root}/mise.toml" 2>/dev/null || hobo_mise trust -a 2>/dev/null || true
	fi
}

mise_install_project_tools() {
	local root="${1:-.}"
	(
		cd "$root"
		mise_trust_hobo_root "$root"
		hobo_mise install
	)
}
