#!/bin/sh
set -eu
# Wrangler always pulls its egress image, including images just built locally.
# Resolve only the content-addressed HoBo image from the local daemon cache.
if [ "${1:-}" = pull ] && [ "${2:-}" = "${HOBO_CI_PROXY_IMAGE:-}" ] && [ -n "${HOBO_CI_PROXY_IMAGE:-}" ]; then
  exec "${HOBO_CI_DOCKER_BIN:-docker}" image inspect "$2" --format '{{.Id}}'
fi
exec "${HOBO_CI_DOCKER_BIN:-docker}" "$@"
