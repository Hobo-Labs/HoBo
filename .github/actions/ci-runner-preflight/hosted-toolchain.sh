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
		MISE_VERSION="v$(tr -d '[:space:]' <"${mise_version_file}")"
		export MISE_VERSION
		# shellcheck source=scripts/lib/mise-path.sh
		source scripts/lib/mise-path.sh
		mise_ensure_on_path
	fi
	mise trust ./mise.toml
	mise install
	echo "${HOME}/.local/bin" >>"${GITHUB_PATH}"
	mise bin-paths >>"${GITHUB_PATH}"
	echo "hosted toolchain: $(mise --version), tools from mise.lock"
	# The headless shell the image bakes in, at the same path and from the same
	# pins (the image's Dockerfile is their one source). Only jobs that run
	# browser tests ask for it: it is a download the others do not need.
	if [ "${HOBO_CI_HOSTED_BROWSER:-}" = "true" ]; then
		dockerfile=packages/ci-gh-actions/deploy/ci-runner/base/Dockerfile
		pin() { sed -n "s/^ARG $1=//p" "${dockerfile}"; }
		revision="$(pin PLAYWRIGHT_CHROMIUM_REVISION)"
		case "$(uname -m)" in
		aarch64 | arm64)
			url="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-headless-shell-linux-arm64.zip"
			digest="$(pin PLAYWRIGHT_HEADLESS_SHELL_SHA256_ARM64)"
			;;
		*)
			url="https://cdn.playwright.dev/builds/cft/$(pin PLAYWRIGHT_CHROMIUM_VERSION)/linux64/chrome-headless-shell-linux64.zip"
			digest="$(pin PLAYWRIGHT_HEADLESS_SHELL_SHA256_X64)"
			;;
		esac
		browsers=/opt/pw-browsers
		cache="${HOBO_CI_PLAYWRIGHT_CACHE:-${HOME}/.cache/hobo-ci/playwright}"
		mkdir -p "${cache}"
		cache_name="chromium-headless-shell-$(uname -m)-${digest}.zip"
		archive="${cache}/${cache_name}"
		dir="${browsers}/chromium_headless_shell-${revision}"
		if [ ! -f "${dir}/INSTALLATION_COMPLETE" ]; then
			if [ ! -f "${archive}" ] || ! echo "${digest}  ${archive}" | sha256sum -c -; then
				tmp="${archive}.partial"
				attempt=1
				max_attempts="${HOBO_CI_PLAYWRIGHT_DOWNLOAD_ATTEMPTS:-4}"
				while [ "${attempt}" -le "${max_attempts}" ]; do
					if curl -fsSL \
						--connect-timeout "${HOBO_CI_PLAYWRIGHT_CONNECT_TIMEOUT:-15}" \
						--max-time "${HOBO_CI_PLAYWRIGHT_PER_ATTEMPT_MAX:-90}" \
						"${url}" -o "${tmp}" \
						&& echo "${digest}  ${tmp}" | sha256sum -c -; then
						mv -f "${tmp}" "${archive}"
						break
					fi
					rm -f "${tmp}"
					if [ "${attempt}" -ge "${max_attempts}" ]; then
						echo "::error::playwright headless-shell download failed after ${max_attempts} attempts" >&2
						exit 1
					fi
					sleep "$(( attempt * 2 < 30 ? attempt * 2 : 30 ))"
					attempt=$(( attempt + 1 ))
				done
			fi
			sudo mkdir -p "${dir}"
			sudo chown -R "$(id -u):$(id -g)" "${browsers}"
			unzip -q "${archive}" -d "${dir}"
			touch "${dir}/INSTALLATION_COMPLETE" "${dir}/DEPENDENCIES_VALIDATED"
		fi
		echo "PLAYWRIGHT_BROWSERS_PATH=${browsers}" >>"${GITHUB_ENV}"
		echo "hosted toolchain: headless shell ${revision} at ${dir}"
	fi
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
