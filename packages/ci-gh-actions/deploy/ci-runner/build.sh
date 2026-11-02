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

runner_ctx="${root}/packages/ci-gh-actions/deploy/ci-runner"
base_dockerfile="${runner_ctx}/base/Dockerfile"
oci_dir="${runner_ctx}/oci-layout"
local_registry="127.0.0.1:5000"
registry_container="hobo-ci-registry"
base_repo="${local_registry}/hobo-ci-runner-base"
base_ref="${base_repo}:local"

if ! command -v mise >/dev/null 2>&1 || [[ "$(mise --version | awk '{print $1}')" != "$mise_version" ]]; then
  curl -fsSL https://mise.run | MISE_VERSION="$mise_version" sh
fi
mise trust ./mise.toml
mise install

node --no-warnings scripts/ci-runner-image-version.mts >/tmp/hobo-ci-runner-version.$$
version="$(tr -d '[:space:]' < /tmp/hobo-ci-runner-version.$$)"
rm -f /tmp/hobo-ci-runner-version.$$

base_image="$(node --no-warnings -e "import { CI_RUNNER_DEBIAN_BOOKWORM_SLIM } from './scripts/lib/ci-runner-contract.mts'; console.log(CI_RUNNER_DEBIAN_BOOKWORM_SLIM)")"

echo "Verifying base image digest resolves: ${base_image}"
docker manifest inspect "${base_image}" >/dev/null

echo "Building base image (native $(uname -m)), tag hobo-ci-runner-base:local"
docker build -f "${base_dockerfile}" -t hobo-ci-runner-base:local "${runner_ctx}"

ensure_local_registry() {
  if curl -fsS "http://${local_registry}/v2/" >/dev/null 2>&1; then
    return 0
  fi
  if docker ps -a --format '{{.Names}}' | grep -qx "${registry_container}"; then
    docker start "${registry_container}" >/dev/null
  else
    docker run -d -p 5000:5000 --name "${registry_container}" registry:2 >/dev/null
  fi
  for _ in $(seq 1 30); do
    if curl -fsS "http://${local_registry}/v2/" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  echo "local registry ${local_registry} did not become ready" >&2
  exit 1
}

echo "Publishing base to local registry ${base_ref} (avoids Docker Hub 401 on mise oci --from)"
ensure_local_registry
docker tag hobo-ci-runner-base:local "${base_ref}"
docker push "${base_ref}"

echo "Packaging mise.lock tools into OCI layout at ${oci_dir}"
rm -rf "${oci_dir}"
mise oci build -o "${oci_dir}" --from "${base_ref}"

if ! command -v skopeo >/dev/null 2>&1; then
  echo "skopeo is required to load oci:${oci_dir} into docker-daemon:hobo-ci-worker:${version}" >&2
  exit 1
fi

echo "Loading image into Docker as hobo-ci-worker:${version} and hobo-ci-worker:local"
skopeo copy "oci:${oci_dir}" "docker-daemon:hobo-ci-worker:${version}"
skopeo copy "oci:${oci_dir}" "docker-daemon:hobo-ci-worker:local"

echo "Runner image contract (inside container):"
docker run --rm \
  -v "${root}:/workspace:ro" -w /workspace \
  -e HOBO_CI_RUNNER_CONTRACT=live \
  hobo-ci-worker:local \
  node --no-warnings scripts/ci-runner-preflight.mts

digest="$(docker inspect --format='{{index .RepoDigests 0}}' hobo-ci-worker:local 2>/dev/null || true)"
echo "Done. ${digest:-hobo-ci-worker:local (daemon tag only)}"
