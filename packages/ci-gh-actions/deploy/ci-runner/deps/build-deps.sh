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
verification="$(mktemp -d)"
contract_log="$(mktemp)"
cap="${HOBO_CI_WORKER_BUILDER_CACHE_CAP:-${HOBO_CI_WORKER_BUILDER_KEEP_STORAGE:-4GB}}"
if [[ ! "$cap" =~ ^[0-9]+([.][0-9]+)?[KMGT]B$ ]]; then
  echo "invalid BuildKit cache cap: ${cap}" >&2
  exit 1
fi
inode_headroom="${HOBO_CI_DEPS_BUILD_INODE_HEADROOM:-400000}"
byte_headroom="${HOBO_CI_DEPS_BUILD_BYTE_HEADROOM:-8589934592}"
if [[ ! "$inode_headroom" =~ ^[0-9]+$ ]]; then
  echo "invalid HOBO_CI_DEPS_BUILD_INODE_HEADROOM" >&2
  exit 1
fi
if [[ ! "$byte_headroom" =~ ^[0-9]+$ ]]; then
  echo "invalid HOBO_CI_DEPS_BUILD_BYTE_HEADROOM" >&2
  exit 1
fi

sample_docker_headroom() {
  local sample_path="$1"
  local iavail avail
  iavail="$(df --output=iavail "$sample_path" | tail -n1 | tr -d '[:space:]')"
  avail="$(df -B1 --output=avail "$sample_path" | tail -n1 | tr -d '[:space:]')"
  if [[ ! "$iavail" =~ ^[0-9]+$ || ! "$avail" =~ ^[0-9]+$ ]]; then
    echo "invalid Docker data root df sample for ${sample_path}" >&2
    exit 1
  fi
  printf '%s %s\n' "$iavail" "$avail"
}

docker_data_root_device() {
  local docker_root="$1"
  local image="$2"
  if [[ -z "$docker_root" || -z "$image" ]]; then
    return 0
  fi
  if ! docker image inspect "$image" >/dev/null 2>&1; then
    return 0
  fi
  docker run --rm --network=none -v /:/host:ro "$image" \
    stat -c '%d' "/host${docker_root}" 2>/dev/null || true
}

resolve_deps_headroom_sample_path() {
  local docker_root="$1"
  local image="$2"
  if [[ -n "$docker_root" && -d "$docker_root" ]]; then
    printf '%s\n' "$docker_root"
    return 0
  fi
  local docker_dev candidate cand_dev
  docker_dev="$(docker_data_root_device "$docker_root" "$image")"
  local candidates=()
  if [[ -n "${HOBO_CI_HOST_JOB_DIRECTORY:-}" && -d "${HOBO_CI_HOST_JOB_DIRECTORY}" ]]; then
    candidates+=("${HOBO_CI_HOST_JOB_DIRECTORY}")
  fi
  if [[ -n "${GITHUB_WORKSPACE:-}" && -d "${GITHUB_WORKSPACE}" ]]; then
    candidates+=("${GITHUB_WORKSPACE}")
  fi
  if [[ -d /pnpm-store ]]; then
    candidates+=("/pnpm-store")
  fi
  candidates+=("/")
  for candidate in "${candidates[@]}"; do
    if [[ -n "$docker_dev" ]]; then
      cand_dev="$(stat -c '%d' "$candidate" 2>/dev/null || true)"
      if [[ -z "$cand_dev" || "$cand_dev" != "$docker_dev" ]]; then
        continue
      fi
    fi
    if sample_docker_headroom "$candidate" >/dev/null 2>&1; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  echo "cannot sample Docker data root for deps build headroom" >&2
  return 1
}

# A keyed miss runs pnpm install and mv into /opt/hobo-deps inside BuildKit.
# That overlay can exhaust the box and red concurrent main jobs. Prune only
# the builder cache (never an unfiltered image prune) and refuse the rebuild
# if headroom is still short.
ensure_deps_build_headroom() {
  local docker_root sample_path iavail avail
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null || true)"
  sample_path="$(resolve_deps_headroom_sample_path "$docker_root" "$base")" || exit 1
  read -r iavail avail < <(sample_docker_headroom "$sample_path")
  if (( iavail >= inode_headroom && avail >= byte_headroom )); then
    return 0
  fi
  echo "deps rebuild headroom low (dockerRoot=${docker_root} samplePath=${sample_path} inodes=${iavail} bytes=${avail}); pruning BuildKit cache"
  docker builder prune -f --keep-storage "$cap"
  read -r iavail avail < <(sample_docker_headroom "$sample_path")
  if (( iavail >= inode_headroom && avail >= byte_headroom )); then
    echo "deps rebuild headroom recovered after builder prune (inodes=${iavail} bytes=${avail})"
    return 0
  fi
  echo "refusing deps rebuild: Docker data root still below headroom after builder prune (inodes=${iavail} need ${inode_headroom}; bytes=${avail} need ${byte_headroom})" >&2
  exit 1
}
cleanup() {
  rm -rf "$context" "$verification" "$contract_log"
}
trap cleanup EXIT

toolchain="$(node --no-warnings scripts/ci-runner-image-version.mts)"
base="hobo-ci-worker:${toolchain}"
if ! docker image inspect "$base" >/dev/null 2>&1; then
  export GITHUB_TOKEN="${GITHUB_TOKEN:-${GHCR_TOKEN:-}}"
  echo "Toolchain ${base} not in this Docker context; resolving via ensure-ci-worker-image"
  node --no-warnings scripts/ci/ensure-ci-worker-image.mts
fi
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

verify_mount_contract() {
  echo "Verifying $candidate under a real job-directory mount"
  HOBO_CI_DEPS_MOUNT_CONTRACT=1 \
    HOBO_CI_DEPS_IMAGE="$candidate" \
    HOBO_CI_DEPS_LAYER="$key" \
    node --experimental-strip-types --no-warnings --import ./scripts/lib/ts-source-resolve.mts \
      --test scripts/test/ci-deps-image-mount.test.ts
}

if docker image inspect "$candidate" >/dev/null 2>&1; then
  echo "Reusing local $candidate"
  if [ "$promote" = 1 ]; then
    verify_mount_contract
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
ensure_deps_build_headroom
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
cp -a "$context/." "$verification/"
mkdir -p "$verification/scripts/ci"
cp scripts/ci/deps-layer.mts "$verification/scripts/ci/deps-layer.mts"
tar -C "$verification" -cf - . \
  | docker run --rm -i --network=none \
    "${docker_memory_args[@]}" \
    --tmpfs /pnpm-store:rw,uid=1000,gid=1000,mode=0755 \
    -e npm_config_store_dir=/pnpm-store \
    -e npm_config_ignore_scripts=true \
    -e HOBO_CI_DEPS_LAYER="$key" \
    "$candidate" \
    sh -ec 'mkdir -p /opt/actions-runner/_hobo_work/HoBo/HoBo && cd /opt/actions-runner/_hobo_work/HoBo/HoBo && tar -xf - && node --experimental-strip-types scripts/ci/deps-layer.mts link && pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false' \
  | tee "$contract_log"
grep -q 'Already up to date' "$contract_log" || {
  echo "deps image contract failed: pnpm install was not already up to date" >&2
  exit 1
}

if [ "$promote" = 1 ]; then
  verify_mount_contract
  docker tag "$candidate" hobo-ci-deps:local
  echo "Promoted $candidate to hobo-ci-deps:local"
else
  echo "Built and verified $candidate without promotion"
fi
node --experimental-strip-types --no-warnings scripts/ci-runner-image-gc.mts "$candidate"
"${prune_command[@]}" -f --keep-storage "$cap"
