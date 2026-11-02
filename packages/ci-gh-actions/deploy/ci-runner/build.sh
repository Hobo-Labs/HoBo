#!/usr/bin/env bash
# Hermetic HoBo CI runner: base Dockerfile + `mise oci build` (experimental).
# Run on a native-arch Linux host with Docker, skopeo, and pinned mise (see mise-version.txt).
# From repo root:
#   bash packages/ci-gh-actions/deploy/ci-runner/build.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../.." && pwd)"
cd "$root"

mise_version="$(tr -d '[:space:]' < packages/ci-gh-actions/deploy/ci-runner/mise-version.txt)"
export MISE_EXPERIMENTAL=1
export PATH="${HOME}/.local/bin:${PATH}"

if ! command -v mise >/dev/null 2>&1 || [[ "$(mise --version | awk '{print $1}')" != "$mise_version" ]]; then
  curl -fsSL https://mise.run | MISE_VERSION="$mise_version" sh
fi
mise trust ./mise.toml
mise install

version="$(node --import tsx scripts/ci-runner-image-version.mts)"
base_dockerfile="packages/ci-gh-actions/deploy/ci-runner/base/Dockerfile"
oci_dir="packages/ci-gh-actions/deploy/ci-runner/oci-layout"

echo "Building base image (native $(uname -m)), tag hobo-ci-runner-base:local"
docker build -f "$base_dockerfile" -t hobo-ci-runner-base:local .

echo "Packaging mise.lock tools into OCI layout at ${oci_dir}"
rm -rf "$oci_dir"
mise oci build -o "$oci_dir" --from hobo-ci-runner-base:local

if ! command -v skopeo >/dev/null 2>&1; then
  echo "skopeo is required to load oci:${oci_dir} into docker-daemon:hobo-ci-worker:${version}" >&2
  exit 1
fi

echo "Loading image into Docker as hobo-ci-worker:${version} and hobo-ci-worker:local"
skopeo copy "oci:${oci_dir}" "docker-daemon:hobo-ci-worker:${version}"
skopeo copy "oci:${oci_dir}" "docker-daemon:hobo-ci-worker:local"

echo "Runner image contract (inside container):"
docker run --rm \
  -v "$root:/workspace:ro" -w /workspace \
  -e HOBO_CI_RUNNER_CONTRACT=live \
  hobo-ci-worker:local \
  node --import tsx scripts/ci-runner-preflight.mts

digest="$(docker inspect --format='{{index .RepoDigests 0}}' hobo-ci-worker:local 2>/dev/null || true)"
echo "Done. ${digest:-hobo-ci-worker:local (daemon tag only)}"
