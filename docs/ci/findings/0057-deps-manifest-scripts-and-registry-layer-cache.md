---
type: CI Performance Finding
title: "Finding 57: deps manifest scripts and the registry layer cache"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 57: deps manifest scripts and the registry layer cache

Main push run **41900082129**, after **#1711**, took **306 s**, versus **99–103 s** before. `Main full gate` ran **19:48:05–19:49:37**, but the deps job rebuilt and pushed after the gate. `Build deps image and verify offline install` took **148 s**: BuildKit `pnpm fetch` **19.3 s**, offline install **64.7 s**, final `COPY` **23.2 s**, layer export **18.6 s**, and verification **6 s**. The blocking GHCR push then took **125 s**. #1711 changed only root `package.json` scripts, but the key changed to `ve9efb8bcd14c-594459e6d8bdaabe` because every importer manifest was hashed and staged verbatim.

## Hash only inputs to the produced layer

`normalizeDepsManifest` now parses each importer manifest once, removes only its top-level `scripts` field, and serializes every other field with recursively sorted object keys. The key hash and `--stage` context both use that output. A scripts-only edit to the root or a workspace manifest therefore preserves both the key and every staged context byte. Changes to dependency fields, dependency metadata, `bin`, identity/version fields, root `pnpm`, `packageManager`, `engines`, platform/libc fields, `workspaces`, `publishConfig`, and unlisted fields still change the key.

This is safe because the Dockerfile installs with `--ignore-scripts` and then rebuilds only `@ast-grep/cli`, `@bufbuild/buf`, `esbuild`, and `protobufjs` explicitly. The `Already up to date` verification also sets `npm_config_ignore_scripts=true`. The gates compare computed and image-label keys, not raw manifests; on a miss they install from the full checkout, where lifecycle scripts remain available. Thus no importer lifecycle-script keys need to remain in the image hash. The normalizer and build-recipe edit changes the real key once, as expected; no key was bumped by hand.

For a repeat of the scripts-only #1711 push, the existing keyed local image now matches, so the deps job skips the entire **148 s** build and the publisher has no new tag to push. This removes that run's avoidable rebuild rather than merely speeding it up.

## Restore BuildKit stages without blocking the gate

When buildx and `GITHUB_REPOSITORY` are available, `build-deps.sh` imports `ghcr.io/<repo lowercase>/hobo-ci-deps:buildcache` with `--cache-from`. A missing cache is a BuildKit cache miss, not a build failure. The deps job has `packages: read`, never `packages: write`, and logs in only when its token exists. Its builds use the named `hobo-ci-deps-cache` `docker-container` builder so the publisher can reuse their local cache.

After the existing bounded image push, `publish-deps.sh` stages the same normalized inputs and reruns the build on that builder with `--cache-to type=registry,ref=…:buildcache,mode=max`, bounded by **120 s**. It creates the builder idempotently and skips only the export with a clear log when buildx is unavailable. All cache writes and image pushes remain in the separate publisher, off HoBo CI's critical path.

An identical-input rebuild after the box's BuildKit cache was pruned to its **4 GB** cap, or on a fresh box, can reuse every exported stage. A lockfile change still reruns fetch and install: `RUN --mount=type=cache` contents, including the pnpm store, are never exported by `mode=max`. The cache does not remove the scripts-only rebuild in run **41900082129**; manifest normalization does. There is no Docker daemon in this environment, so script/workflow contracts and pure-function tests prove the wiring here, while actual registry-cache hits and timings remain box-side evidence.
