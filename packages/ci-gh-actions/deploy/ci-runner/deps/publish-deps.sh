#!/usr/bin/env bash
# Publish an already-built deps image without making HoBo CI wait for GHCR.
set -euo pipefail
root="$(cd "$(dirname "$0")/../../../../.." && pwd)"
cd "$root"

key="$(node --no-warnings scripts/ci/deps-key.mts)"
candidate="hobo-ci-deps:${key}"
local_key="$(docker image inspect hobo-ci-deps:local --format '{{ index .Config.Labels "hobo.ci.deps-key" }}' 2>/dev/null || true)"
source="$candidate"
if ! docker image inspect "$candidate" >/dev/null 2>&1; then
  if [ "$local_key" = "$key" ]; then
    source="hobo-ci-deps:local"
  else
    echo "No local deps image for ${key}; skipping GHCR publish"
    exit 0
  fi
fi

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

docker tag "$source" "$image"
timeout --signal=TERM --kill-after=15s 240s docker push "$image"
