#!/usr/bin/env bash
# Publish a keyed deps image without making HoBo CI wait for GHCR.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../.." && pwd)"
cd "$root"
export GITHUB_TOKEN="${GITHUB_TOKEN:-${GHCR_TOKEN:-}}"

key="$(node --no-warnings scripts/ci/deps-key.mts)"
candidate="hobo-ci-deps:${key}"
repository="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"
image="ghcr.io/${repository,,}/hobo-ci-deps:${key}"
if [ -z "${GHCR_TOKEN:-}" ]; then
  echo "GHCR_TOKEN is unavailable; skipping deps image publish"
  exit 0
fi
printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "${GITHUB_ACTOR:?GITHUB_ACTOR is required}" --password-stdin
if docker manifest inspect "$image" >/dev/null 2>&1; then
  echo "GHCR already has ${image}; skipping push"
  exit 0
fi

local_key="$(docker image inspect hobo-ci-deps:local --format '{{ index .Config.Labels "hobo.ci.deps-key" }}' 2>/dev/null || true)"
source="$candidate"
if ! docker image inspect "$candidate" >/dev/null 2>&1; then
  if [ "$local_key" = "$key" ]; then
    source="hobo-ci-deps:local"
  else
    echo "No local deps image for ${key}; building before GHCR publish"
    node --experimental-strip-types --no-warnings scripts/ci/wait-deps-build-window.mts
    bash packages/ci-gh-actions/deploy/ci-runner/deps/build-deps.sh
  fi
fi

docker tag "$source" "$image"
# docker push uploads only blobs the registry lacks, so unchanged bucket layers are skipped.
timeout --signal=TERM --kill-after=15s 240s docker push "$image"

cache_image="ghcr.io/${repository,,}/hobo-ci-deps:buildcache"
deps_uses_containerd_image_store() {
  [[ "$(docker info --format '{{json .DriverStatus}}' 2>/dev/null)" == *io.containerd.snapshotter* ]]
}
if ! deps_uses_containerd_image_store; then
  echo "deps registry cache export skipped: classic image store"
  exit 0
fi
if ! docker buildx version >/dev/null 2>&1; then
  echo "docker buildx is unavailable; skipping deps buildcache export"
  exit 0
fi
buildx_help="$(docker buildx build --help 2>&1 || true)"

context="$(mktemp -d)"
trap 'rm -rf "$context"' EXIT
toolchain="$(docker image inspect "$source" --format '{{ index .Config.Labels "hobo.ci.toolchain" }}')"
if [[ ! "$toolchain" =~ ^v[0-9a-f]{12}$ ]]; then
  echo "deps image has no valid toolchain label; cannot export buildcache" >&2
  exit 1
fi
staged_key="$(node --no-warnings scripts/ci/deps-key.mts --toolchain "$toolchain" --stage "$context")"
if [ "$staged_key" != "$key" ]; then
  echo "staged deps key ${staged_key} does not match published key ${key}" >&2
  exit 1
fi

rewrite_args=()
if grep -q -- '--rewrite-timestamp' <<<"$buildx_help"; then
  rewrite_args=(--rewrite-timestamp=true)
fi
docker_memory_args=()
if [[ -n "${HOBO_CI_DEPS_BUILD_MEMORY_MB:-}" ]]; then
  if [[ ! "${HOBO_CI_DEPS_BUILD_MEMORY_MB}" =~ ^[0-9]+$ ]] || (( HOBO_CI_DEPS_BUILD_MEMORY_MB < 512 )); then
    echo "invalid HOBO_CI_DEPS_BUILD_MEMORY_MB" >&2
    exit 2
  fi
  docker_memory_args=(--memory "${HOBO_CI_DEPS_BUILD_MEMORY_MB}m")
fi

timeout --signal=TERM --kill-after=15s 120s docker buildx build \
  "${docker_memory_args[@]}" \
  "${rewrite_args[@]}" \
  --cache-from "type=registry,ref=${cache_image}" \
  --cache-to "type=registry,ref=${cache_image},mode=min" \
  --build-arg "TOOLCHAIN_IMAGE=hobo-ci-worker:${toolchain}" \
  --build-arg "DEPS_KEY=${key}" \
  --build-arg "TOOLCHAIN_VERSION=${toolchain}" \
  --build-arg "SOURCE_DATE_EPOCH=0" \
  -f packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile \
  -t "$candidate" "$context"
