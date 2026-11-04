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
cleanup() {
  rm -rf "$context" "$contract_log"
}
trap cleanup EXIT

key="$(node --no-warnings scripts/ci/deps-key.mts --stage "$context")"
toolchain="$(node --no-warnings scripts/ci-runner-image-version.mts)"
base="hobo-ci-worker:${toolchain}"
candidate="hobo-ci-deps:${key}"
epoch="$(git log -1 --format=%ct)"

if docker image inspect "$candidate" >/dev/null 2>&1; then
  echo "Reusing local $candidate"
  if [ "$promote" = 1 ]; then
    docker tag "$candidate" hobo-ci-deps:local
    echo "Promoted $candidate to hobo-ci-deps:local"
  fi
  node --no-warnings scripts/ci/deps-image-gc.mts "$candidate"
  exit 0
fi

docker image inspect "$base" >/dev/null 2>&1 || {
  echo "missing toolchain image $base; run packages/ci-gh-actions/deploy/ci-runner/build.sh first" >&2
  exit 1
}

echo "Building $candidate (fetch network restricted to lockfile-verified downloads; install offline)"
docker build \
  --build-arg "TOOLCHAIN_IMAGE=${base}" \
  --build-arg "DEPS_KEY=${key}" \
  --build-arg "TOOLCHAIN_VERSION=${toolchain}" \
  --build-arg "SOURCE_DATE_EPOCH=${epoch}" \
  -f packages/ci-gh-actions/deploy/ci-runner/deps/Dockerfile \
  -t "$candidate" "$context"

echo "Verifying the job's offline install is already up to date"
tar -C "$context" -cf - . \
  | docker run --rm -i --network=none \
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
node --no-warnings scripts/ci/deps-image-gc.mts "$candidate"
