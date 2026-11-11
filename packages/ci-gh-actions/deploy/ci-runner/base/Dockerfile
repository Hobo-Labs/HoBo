# syntax=docker/dockerfile:1.19
# Digest-pinned OS layer for `mise oci build` ([oci].from). System packages + Actions runner
# bundle only — Node/pnpm/cue/turbo/gitleaks come from mise.lock tool layers.
# Build from deploy/ci-runner (small context); see build.sh.
#   docker build -f base/Dockerfile -t hobo-ci-runner-base:local .
FROM debian:bookworm-slim@sha256:99c0b25c46d0214d5a2091092e7908907dcaecd6a962cde0ac700acee222b6f3

ARG RUNNER_VERSION=2.338.2
ARG RUNNER_SHA256_X64=baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40
ARG RUNNER_SHA256_ARM64=670adb2f268fe21dcbb58b3db0e0aa9d5b3bddfe2c651481336e561ff86de945
ARG TARGETARCH

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

COPY system-packages.txt /tmp/system-packages.txt
RUN apt-get update \
  && grep -v '^#' /tmp/system-packages.txt | grep -v '^[[:space:]]*$' | xargs apt-get install -y --no-install-recommends \
  && rm -rf /var/lib/apt/lists/* /tmp/system-packages.txt

RUN groupadd --gid 1000 runner \
  && useradd --uid 1000 --gid 1000 --create-home --shell /bin/bash runner

RUN case "${TARGETARCH:-amd64}" in \
      arm64) runner_arch=arm64; digest="${RUNNER_SHA256_ARM64}" ;; \
      amd64) runner_arch=x64; digest="${RUNNER_SHA256_X64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && archive="actions-runner-linux-${runner_arch}-${RUNNER_VERSION}.tar.gz" \
  && url="https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${archive}" \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 "$url" -o "/tmp/${archive}" \
  && echo "${digest}  /tmp/${archive}" | sha256sum -c - \
  && mkdir -p /opt/actions-runner \
  && tar -xzf "/tmp/${archive}" -C /opt/actions-runner \
  && rm "/tmp/${archive}" \
  && chown -R runner:runner /opt/actions-runner \
  && usermod -aG docker runner

# Playwright's pinned headless shell (playwright-core browsers.json), so browser
# tests do not download one per job. The pins are checked against
# CI_RUNNER_PLAYWRIGHT_CHROMIUM in scripts/lib/ci-runner-contract.mts.
ARG PLAYWRIGHT_CHROMIUM_REVISION=1234
ARG PLAYWRIGHT_CHROMIUM_VERSION=151.0.7922.34
ARG PLAYWRIGHT_HEADLESS_SHELL_SHA256_X64=3cfc2bd00d1bafcf8a68dc74c9c92bb7150ddc8d26ade948a776316e1cec4f14
ARG PLAYWRIGHT_HEADLESS_SHELL_SHA256_ARM64=b03443e1e1a60d06e07b6cdfe650b8c2bfcbb3db497d2b652f73dc6912f4ae15
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers

RUN case "${TARGETARCH:-amd64}" in \
      arm64) url="https://cdn.playwright.dev/dbazure/download/playwright/builds/chromium/${PLAYWRIGHT_CHROMIUM_REVISION}/chromium-headless-shell-linux-arm64.zip"; digest="${PLAYWRIGHT_HEADLESS_SHELL_SHA256_ARM64}" ;; \
      amd64) url="https://cdn.playwright.dev/builds/cft/${PLAYWRIGHT_CHROMIUM_VERSION}/linux64/chrome-headless-shell-linux64.zip"; digest="${PLAYWRIGHT_HEADLESS_SHELL_SHA256_X64}" ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac \
  && curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 "$url" -o /tmp/headless-shell.zip \
  && echo "${digest}  /tmp/headless-shell.zip" | sha256sum -c - \
  && dir="${PLAYWRIGHT_BROWSERS_PATH}/chromium_headless_shell-${PLAYWRIGHT_CHROMIUM_REVISION}" \
  && mkdir -p "$dir" \
  && unzip -q /tmp/headless-shell.zip -d "$dir" \
  && touch "$dir/INSTALLATION_COMPLETE" "$dir/DEPENDENCIES_VALIDATED" \
  && rm /tmp/headless-shell.zip \
  && chmod -R a+rX "${PLAYWRIGHT_BROWSERS_PATH}"

USER runner
WORKDIR /home/runner
ENV HOBO_CI_RUNNER_BASE=1
ENV PATH="/opt/actions-runner:${PATH}"

CMD ["sleep", "infinity"]
