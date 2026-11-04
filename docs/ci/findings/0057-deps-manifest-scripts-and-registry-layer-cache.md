---
type: CI Performance Finding
title: "Finding 57: deps manifest scripts and the registry layer cache"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 57: deps manifest scripts and the registry layer cache

Main push run **41900082129**, after **#1711**, took **306 s**, versus **99–103 s** before. `Main full gate` ran **19:48:05–19:49:37**, but the deps job rebuilt and pushed after the gate. `Build deps image and verify offline install` took **148 s**: BuildKit `pnpm fetch` **19.3 s**, offline install **64.7 s**, final `COPY` **23.2 s**, layer export **18.6 s**, and verification **6 s**. The blocking GHCR push then took **125 s**. #1711 changed only root `package.json` scripts, but the key changed to `ve9efb8bcd14c-594459e6d8bdaabe` because every importer manifest was hashed and staged verbatim.

## Hash only inputs to the produced layer

`normalizeDepsManifest` now parses each importer manifest once and whitelists only `name`, `version`, `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `peerDependenciesMeta`, `dependenciesMeta`, `bundleDependencies`/`bundledDependencies`, `bin`, `directories.bin`, `publishConfig.directory`/`bin`/`linkDirectory`, `os`, `cpu`, `libc`, `engines`, `devEngines`, `packageManager`, `workspaces`, `overrides`, `resolutions`, and the root `pnpm` field. It serializes the retained values with sorted object keys for both the key hash and `--stage` context. Scripts, descriptions, exports, entry points, types, files, keywords, repository/license metadata, other `publishConfig` keys, non-root `pnpm`, and unlisted fields cannot change either output.

Pnpm's own [10.x manifest documentation](https://pnpm.io/10.x/package_json) and [10.33.4 manifest reader](https://github.com/pnpm/pnpm/blob/v10.33.4/pkg-manifest/read-project-manifest/src/index.ts) identified `devEngines` as an additional required field: `devEngines.runtime` with `onFail: download` is converted into a runtime dependency. The [up-to-date checker](https://github.com/pnpm/pnpm/blob/v10.33.4/lockfile/verification/src/satisfiesPackageManifest.ts) compares dependency specifiers, `dependenciesMeta`, and `publishConfig.directory`; the [bin linker](https://github.com/pnpm/pnpm/blob/v10.33.4/pkg-manager/package-bins/src/index.ts) consumes `name`, `bin`, and `directories.bin`, with runtime shims covered by `engines`. No further dependency-layout fields were added after reviewing those paths.

This is safe because the Dockerfile installs with `--ignore-scripts` and then rebuilds only `@ast-grep/cli`, `@bufbuild/buf`, `esbuild`, and `protobufjs` explicitly. The `Already up to date` verification also sets `npm_config_ignore_scripts=true`. The gates compare computed and image-label keys, not raw manifests; on a miss they install from the full checkout, where lifecycle scripts remain available. Thus no importer lifecycle-script keys need to remain in the image hash. The normalizer and build-recipe edit changes the real key once, as expected; no key was bumped by hand.

For a repeat of the scripts-only #1711 push, the existing keyed local image now matches, so the deps job skips the entire **148 s** build and the publisher has no new tag to push. This removes that run's avoidable rebuild rather than merely speeding it up.

## Restore BuildKit stages without blocking the gate

When buildx and `GITHUB_REPOSITORY` are available, `build-deps.sh` imports `ghcr.io/<repo lowercase>/hobo-ci-deps:buildcache` with `--cache-from`. A missing cache is a BuildKit cache miss, not a build failure. The deps job has `packages: read`, never `packages: write`, and logs in only when its token exists. Its builds use the named `hobo-ci-deps-cache` `docker-container` builder so the publisher can reuse their local cache.

Run **41900082129**'s **125 s** `Push deps image to GHCR` step no longer exists in `hobo-ci.yml`. For the deps image, only `ci-deps-publish.yml` grants `packages: write` and calls `publish-deps.sh` to push, after a successful main fabric run; manual dispatch remains available. After that bounded image push, the script stages the same normalized inputs and reruns the build on the shared builder with `--cache-to type=registry,ref=…:buildcache,mode=max`, bounded by **120 s**. It creates the builder idempotently and skips only the export with a clear log when buildx is unavailable. All cache writes and image pushes remain in the separate publisher, off HoBo CI's critical path.

An identical-input rebuild after the box's BuildKit cache was pruned to its **4 GB** cap, or on a fresh box, can reuse every exported stage. A lockfile change still reruns fetch and install: `RUN --mount=type=cache` contents, including the pnpm store, are never exported by `mode=max`. The cache does not remove the scripts-only rebuild in run **41900082129**; manifest normalization does. There is no Docker daemon in this environment, so script/workflow contracts and pure-function tests prove the wiring here, while actual registry-cache hits and timings remain box-side evidence.
