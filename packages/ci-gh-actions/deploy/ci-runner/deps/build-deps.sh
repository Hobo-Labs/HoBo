#!/usr/bin/env bash
# Build a lockfile-keyed node_modules layer. Only the fetch stage has network access.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../.." && pwd)"
cd "$root"

promote=1
case "${1:-}" in
  "") ;;
  --no-promote) promote=0 ;;
  *) echo "usage: $0 [--no-promote]" >&2; exit 2 ;;
esac

context="$(mktemp -d)"
contract_log="$(mktemp)"
cap="${HOBO_CI_WORKER_BUILDER_CACHE_CAP:-${HOBO_CI_WORKER_BUILDER_KEEP_STORAGE:-4GB}}"
if [[ ! "$cap" =~ ^[0-9]+([.][0-9]+)?[KMGT]B$ ]]; then
  echo "invalid BuildKit cache cap: ${cap}" >&2
  exit 1
fi
cleanup() {
  rm -rf "$context" "$contract_log"
}
trap cleanup EXIT

toolchain="$(node --no-warnings scripts/ci-runner-image-version.mts)"
base="hobo-ci-worker:${toolchain}"
if ! docker image inspect "$base" >/dev/null 2>&1; then
  computed_toolchain="$toolchain"
  toolchain=""
  if worker_tags="$(docker image inspect hobo-ci-worker:local --format '{{range .RepoTags}}{{println .}}{{end}}' 2>/dev/null)"; then
    while IFS= read -r tag; do
      if [[ "$tag" =~ ^hobo-ci-worker:(v[0-9a-f]{12})$ ]]; then
        toolchain="${BASH_REMATCH[1]}"
        break
      fi
    done <<< "$worker_tags"
  fi
  if [[ -z "$toolchain" ]]; then
    echo "missing toolchain image hobo-ci-worker:${computed_toolchain} and no versioned tag on hobo-ci-worker:local; run packages/ci-gh-actions/deploy/ci-runner/build.sh first" >&2
    exit 1
  fi
  echo "Computed toolchain image hobo-ci-worker:${computed_toolchain} is missing; using ${toolchain} from hobo-ci-worker:local"
fi
base="hobo-ci-worker:${toolchain}"
echo "Using toolchain image $base"
key="$(node --no-warnings scripts/ci/deps-key.mts --toolchain "${toolchain}" --stage "$context")"
candidate="hobo-ci-deps:${key}"
epoch=0
docker_memory_args=()
if [[ -n "${HOBO_CI_DEPS_BUILD_MEMORY_MB:-}" ]]; then
  if [[ ! "${HOBO_CI_DEPS_BUILD_MEMORY_MB}" =~ ^[0-9]+$ ]] || (( HOBO_CI_DEPS_BUILD_MEMORY_MB < 512 )); then
    echo "invalid HOBO_CI_DEPS_BUILD_MEMORY_MB" >&2
    exit 2
  fi
  docker_memory_args=(--memory "${HOBO_CI_DEPS_BUILD_MEMORY_MB}m")
fi

local_key="$(docker image inspect hobo-ci-deps:local --format '{{ index .Config.Labels "hobo.ci.deps-key" }}' 2>/dev/null || true)"
if [ "$local_key" = "$key" ] && ! docker image inspect "$candidate" >/dev/null 2>&1; then
  docker tag hobo-ci-deps:local "$candidate"
fi

if docker image inspect "$candidate" >/dev/null 2>&1; then
  echo "Reusing local $candidate"
  if [ "$promote" = 1 ]; then
    docker tag "$candidate" hobo-ci-deps:local
    echo "Promoted $candidate to hobo-ci-deps:local"
  fi
  node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"
  docker builder prune -f --keep-storage "$cap"
  exit 0
fi

node --experimental-strip-types scripts/ci/deps-layer-buckets.mts --check
build_command=(docker build)
prune_command=(docker builder prune)
rewrite_args=()
if build_help="$(docker build --help 2>/dev/null)" && grep -q -- '--rewrite-timestamp' <<<"$build_help"; then
  rewrite_args=(--rewrite-timestamp=true)
fi
cache_args=()
deps_uses_containerd_image_store() {
  [[ "$(docker info --format '{{json .DriverStatus}}' 2>/dev/null)" == *io.containerd.snapshotter* ]]
}
if deps_uses_containerd_image_store; then
  if [[ -n "${GITHUB_REPOSITORY:-}" ]]; then
    cache_args=(--cache-from "type=registry,ref=ghcr.io/${GITHUB_REPOSITORY,,}/hobo-ci-deps:buildcache")
  fi
else
  echo "deps registry cache import skipped: classic image store"
fi

echo "Building $candidate (fetch network restricted to lockfile-verified downloads; install offline)"
"${build_command[@]}" \
  "${docker_memory_args[@]}" \
  "${rewrite_args[@]}" \
  "${cache_args[@]}" \
  --build-arg "TOOLCHAIN_IMAGE=${base}" \
  --build-arg "DEPS_KEY=${key}" \
  --build-arg "TOOLCHAIN_VERSION=${toolchain}" \
  --build-arg "SOURCE_DATE_EPOCH=${epoch}" \
  -f packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile \
  -t "$candidate" "$context"

echo "Verifying the job's offline install is already up to date"
tar -C "$context" -cf - . \
  | docker run --rm -i --network=none \
    "${docker_memory_args[@]}" \
    --tmpfs /pnpm-store:rw,uid=1000,gid=1000,mode=0755 \
    -e npm_config_store_dir=/pnpm-store \
    -e npm_config_ignore_scripts=true \
    "$candidate" \
    sh -ec 'cd /opt/actions-runner/_hobo_work/HoBo/HoBo && tar -xf - && pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false' \
  | tee "$contract_log"
grep -q 'Already up to date' "$contract_log" || {
  echo "deps image contract failed: pnpm install was not already up to date" >&2
  exit 1
}

if [ "$promote" = 1 ]; then
  docker tag "$candidate" hobo-ci-deps:local
  echo "Promoted $candidate to hobo-ci-deps:local"
else
  echo "Built and verified $candidate without promotion"
fi
node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"
"${prune_command[@]}" -f --keep-storage "$cap"
