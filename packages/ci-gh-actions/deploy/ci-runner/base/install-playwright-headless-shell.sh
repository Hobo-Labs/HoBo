#!/usr/bin/env bash
# Install pinned chromium headless-shell into PLAYWRIGHT_BROWSERS_PATH.
# Prefer a pre-staged zip in PLAYWRIGHT_CACHE_DIR (populated by build.sh or box cache).
set -euo pipefail

case "${TARGETARCH:-amd64}" in
arm64) arch=arm64 ;;
amd64) arch=amd64 ;;
*)
	echo "unsupported TARGETARCH: ${TARGETARCH}" >&2
	exit 1
	;;
esac

browsers_path="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}"
revision="${PLAYWRIGHT_CHROMIUM_REVISION:?}"
case "${arch}" in
arm64) digest="${PLAYWRIGHT_HEADLESS_SHELL_SHA256_ARM64:?}" ;;
amd64) digest="${PLAYWRIGHT_HEADLESS_SHELL_SHA256_X64:?}" ;;
esac

cache_dir="${PLAYWRIGHT_CACHE_DIR:-/tmp/playwright-cache}"
mkdir -p "${cache_dir}"
cache_name="chromium-headless-shell-${arch}-${digest}.zip"
archive="${cache_dir}/${cache_name}"
tmp="${archive}.partial"

install_dir="${browsers_path}/chromium_headless_shell-${revision}"
if [[ -f "${install_dir}/INSTALLATION_COMPLETE" ]]; then
	exit 0
fi

verify_archive() {
	local file="$1"
	echo "${digest}  ${file}" | sha256sum -c -
}

if [[ -f "${archive}" ]] && verify_archive "${archive}"; then
	:
else
	if [[ "${HOBO_CI_SKIP_PLAYWRIGHT_DOWNLOAD:-}" = "1" ]]; then
		echo "missing verified playwright archive at ${archive}" >&2
		exit 1
	fi
	case "${arch}" in
	arm64)
		url="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${revision}/chromium-headless-shell-linux-arm64.zip"
		;;
	amd64)
		url="https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/linux64/chrome-headless-shell-linux64.zip"
		;;
	esac
	max_attempts="${HOBO_CI_PLAYWRIGHT_DOWNLOAD_ATTEMPTS:-4}"
	connect_timeout="${HOBO_CI_PLAYWRIGHT_CONNECT_TIMEOUT:-15}"
	per_attempt_max="${HOBO_CI_PLAYWRIGHT_PER_ATTEMPT_MAX:-90}"
	backoff="${HOBO_CI_PLAYWRIGHT_BACKOFF_SEC:-2}"
	budget_sec="${HOBO_CI_PLAYWRIGHT_DOWNLOAD_BUDGET_SEC:-240}"
	started=$(date +%s)
	attempt=1
	last_err=""
	while (( attempt <= max_attempts )); do
		now=$(date +%s)
		if (( now - started > budget_sec )); then
			echo "playwright download exceeded ${budget_sec}s budget (last: ${last_err})" >&2
			exit 1
		fi
		if curl -fsSL \
			--connect-timeout "${connect_timeout}" \
			--max-time "${per_attempt_max}" \
			"${url}" -o "${tmp}"; then
			if verify_archive "${tmp}"; then
				mv -f "${tmp}" "${archive}"
				break
			fi
			last_err="digest mismatch for ${tmp}"
		else
			last_err="curl failed for ${url}"
		fi
		rm -f "${tmp}"
		if (( attempt >= max_attempts )); then
			echo "playwright headless-shell download failed: ${last_err}" >&2
			exit 1
		fi
		sleep "${backoff}"
		backoff=$(( backoff * 2 < 30 ? backoff * 2 : 30 ))
		attempt=$(( attempt + 1 ))
	done
fi

mkdir -p "${install_dir}"
unzip -q "${archive}" -d "${install_dir}"
touch "${install_dir}/INSTALLATION_COMPLETE" "${install_dir}/DEPENDENCIES_VALIDATED"
chmod -R a+rX "${browsers_path}"
