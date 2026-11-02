# syntax=docker/dockerfile:1.19
# JIT runner sidecar: curl + git + ICU, non-root node (UID 1000). Build from repo root:
#   docker build -f packages/ci-gh-actions/deploy/worker/Dockerfile -t hobo-ci-worker:local .
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git libicu72 \
  && rm -rf /var/lib/apt/lists/* \
  && corepack enable \
  && corepack prepare pnpm@10.33.4 --activate
USER node
WORKDIR /home/node
CMD ["sleep", "infinity"]
