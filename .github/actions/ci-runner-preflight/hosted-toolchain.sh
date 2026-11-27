#!/usr/bin/env bash
# Gives a GitHub-hosted machine the toolchain the hobo runner image bakes in,
# so a job routed there (scripts/ci/route-runner.mts) runs the same steps.
# A no-op anywhere else: the fleet's image and a local box already carry it.
#
# Before the working tree holds the toolchain's own files (a sparse checkout
# that has not fetched them yet) only Node is put on PATH, which is all the
# checkout needs.
set -euo pipefail

if [ "${RUNNER_ENVIRONMENT:-}" != "github-hosted" ]; then
	exit 0
fi

node_runs_typescript() {
	"$1" -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 18) ? 0 : 1)'
}

mise_version_file=packages/ci-gh-actions/deploy/ci-runner/mise-version.txt
if [ -f mise.toml ] && [ -f scripts/lib/mise-path.sh ] && [ -f "${mise_version_file}" ]; then
	export MISE_EXPERIMENTAL=1
	export PATH="${HOME}/.local/bin:${PATH}"
	if ! command -v mise >/dev/null 2>&1; then
		mise_version="$(tr -d '[:space:]' <"${mise_version_file}")"
		if [[ ! "$mise_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
			echo "::error::invalid pinned mise version" >&2
			exit 1
		fi
		installer_name="mise-v${mise_version}-install.sh"
		pin_file="$(dirname "${BASH_SOURCE[0]}")/mise-installer.sha256"
		if ! checksum="$(awk -v name="$installer_name" '$2 == name && $1 ~ /^[0-9a-f]+$/ && length($1) == 64 { value=$1; count++ } END { if (count != 1) exit 1; print value }' "$pin_file")"; then
			echo "::error::no unique checksum for ${installer_name}" >&2
			exit 1
		fi
		installer_dir="$(mktemp -d /tmp/hobo-mise-installer.XXXXXXXX)"
		trap 'rm -rf "${installer_dir}"' EXIT
		curl -fsSL --retry 3 --retry-all-errors -o "${installer_dir}/${installer_name}" "https://mise.jdx.dev/v${mise_version}/install.sh"
		if ! (cd "$installer_dir" && printf '%s  %s\n' "$checksum" "$installer_name" | sha256sum --check --status); then
			echo "::error::mise installer checksum mismatch" >&2
			exit 1
		fi
		MISE_VERSION="v${mise_version}"
		MISE_INSTALL_URL="file://${installer_dir}/${installer_name}"
		export MISE_VERSION MISE_INSTALL_URL
		# shellcheck source=scripts/lib/mise-path.sh
		source scripts/lib/mise-path.sh
		mise_ensure_on_path
	fi
	mise trust ./mise.toml
	mise install
	echo "${HOME}/.local/bin" >>"${GITHUB_PATH}"
	mise bin-paths >>"${GITHUB_PATH}"
	echo "hosted toolchain: $(mise --version), tools from mise.lock"
	exit 0
fi

cache="${RUNNER_TOOL_CACHE:-/opt/hostedtoolcache}"
for candidate in "$(command -v node || true)" \
	"${cache}"/node/24.*/*/bin/node "${cache}"/node/22.*/*/bin/node; do
	[ -x "${candidate}" ] || continue
	if node_runs_typescript "${candidate}"; then
		dirname "${candidate}" >>"${GITHUB_PATH}"
		echo "hosted toolchain: $("${candidate}" --version) from ${candidate}"
		exit 0
	fi
done
echo "::error::no Node 22.18 or later on this GitHub-hosted machine" >&2
exit 1
