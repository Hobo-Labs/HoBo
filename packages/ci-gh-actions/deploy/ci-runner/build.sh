#!/usr/bin/env bash
# Hermetic HoBo CI runner: base Dockerfile + `mise oci build` (experimental).
# Run on a native-arch Linux host with Docker and pinned mise (see mise-version.txt),
# or inside a HoBo CI job container that mounts the host Docker socket.
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
local_registry=""
registry_container="hobo-ci-registry"
base_image="hobo-ci-runner-base"

if ! command -v mise >/dev/null 2>&1 || [[ "$(mise --version | awk '{print $1}')" != "$mise_version" ]]; then
  curl -fsSL https://mise.run | MISE_VERSION="$mise_version" sh
fi
mise trust ./mise.toml
mise install

node --no-warnings scripts/ci-runner-image-version.mts >/tmp/hobo-ci-runner-version.$$
version="$(tr -d '[:space:]' < /tmp/hobo-ci-runner-version.$$)"
rm -f /tmp/hobo-ci-runner-version.$$

# Registry API, not `docker manifest inspect`: the runner image's Debian docker.io
# CLI rejects the pinned OCI index (its attestation children are OCI manifests).
node --no-warnings scripts/ci-runner-verify-base-digest.mts

# `docker load` reads an OCI image layout from Docker Engine 25 (API 1.44) on;
# skopeo, when present, works with any engine. Refuse before the base build.
if ! command -v skopeo >/dev/null 2>&1; then
  api="$(docker version --format '{{.Server.APIVersion}}')"
  if [[ "$(printf '%s\n' "1.44" "$api" | sort -V | head -n1)" != "1.44" ]]; then
    echo "need skopeo or a Docker Engine with API >= 1.44 (got ${api}) to load the mise oci layout" >&2
    exit 1
  fi
fi

case "$(uname -m)" in
  x86_64) target_arch=amd64 ;;
  aarch64 | arm64) target_arch=arm64 ;;
  *) echo "unsupported host architecture: $(uname -m)" >&2; exit 1 ;;
esac
echo "Building base image (native ${target_arch}), tag ${base_image}:local"
# The legacy builder (Debian's docker.io CLI) does not set TARGETARCH.
docker build --build-arg "TARGETARCH=${target_arch}" \
  -f "${base_dockerfile}" -t "${base_image}:local" "${runner_ctx}"

start_registry() {
  # Any free loopback port: a fixed 5000 collides with whatever else the host runs there.
  docker run -d -p 127.0.0.1::5000 --name "${registry_container}" registry:2 >/dev/null
}

# Two addresses for one registry. The Docker daemon pushes from the host, over the
# published loopback port, which it treats as plain HTTP. This process may be in a job
# container, where 127.0.0.1 is its own loopback, so it falls back to the bridge address.
ensure_local_registry() {
  if ! docker ps -a --format '{{.Names}}' | grep -qx "${registry_container}"; then
    start_registry
  elif ! docker start "${registry_container}" >/dev/null 2>&1; then
    docker rm -f "${registry_container}" >/dev/null
    start_registry
  fi
  local published ip
  published="$(docker port "${registry_container}" 5000/tcp | head -n1)"
  local_registry="127.0.0.1:${published##*:}"
  ip="$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' "${registry_container}" | awk '{print $1}')"
  for _ in $(seq 1 30); do
    for endpoint in "${local_registry}" "${ip}:5000"; do
      if curl -fsS "http://${endpoint}/v2/" >/dev/null 2>&1; then
        return 0
      fi
    done
    sleep 1
  done
  echo "local registry ${registry_container} did not become ready (host ${local_registry}, bridge ${ip}:5000)" >&2
  exit 1
}

echo "Publishing base to local registry (avoids Docker Hub 401 on mise oci --from)"
ensure_local_registry
echo "registry: daemon pushes to ${local_registry}, this process reads ${endpoint}"
docker tag "${base_image}:local" "${local_registry}/${base_image}:local"
docker push "${local_registry}/${base_image}:local"
export MISE_OCI_INSECURE_REGISTRIES="${endpoint}"

candidate="hobo-ci-worker:${version}"
echo "Packaging mise.lock tools into OCI layout at ${oci_dir} (base via ${endpoint})"
rm -rf "${oci_dir}"
# Tagged as the candidate, so loading the layout cannot move :local ahead of the contract.
mise oci build -o "${oci_dir}" --from "${endpoint}/${base_image}:local" --tag "${candidate}"

echo "Loading image into Docker as ${candidate}"
if command -v skopeo >/dev/null 2>&1; then
  skopeo copy "oci:${oci_dir}" "docker-daemon:${candidate}"
else
  loaded="$(tar -C "${oci_dir}" -cf - . | docker load)"
  echo "${loaded}"
  ref="$(printf '%s\n' "${loaded}" | sed -n 's/^Loaded image: //p; s/^Loaded image ID: //p' | tail -n1)"
  if [[ -z "${ref}" ]]; then
    echo "docker load reported no image" >&2
    exit 1
  fi
  docker tag "${ref}" "${candidate}"
fi

# The contract runs in the candidate before it becomes :local, which new jobs use.
# Its inputs are streamed in: a bind mount would name a host path, and inside a
# job container the checkout is not on the host.
echo "Runner image contract (inside ${candidate}):"
tar -C "${root}" -cf - mise.toml mise.lock scripts/ci-runner-preflight.mts scripts/lib/ci-runner-contract.mts \
  | docker run --rm -i -e HOBO_CI_RUNNER_CONTRACT=live "${candidate}" \
    sh -c 'mkdir -p /tmp/contract && tar -xf - -C /tmp/contract && cd /tmp/contract && node --no-warnings scripts/ci-runner-preflight.mts'
docker tag "${candidate}" hobo-ci-worker:local

digest="$(docker inspect --format='{{index .RepoDigests 0}}' hobo-ci-worker:local 2>/dev/null || true)"
echo "Done. ${digest:-hobo-ci-worker:local (daemon tag only)}"
