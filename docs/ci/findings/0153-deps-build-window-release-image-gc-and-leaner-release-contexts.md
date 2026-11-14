---
type: CI Performance Finding
title: "Finding 153: deps build window, release-image GC, and leaner release contexts"
description: "Deps publisher run 42907466487 refused a local rebuild at 150347 free inodes against a fixed 400000 floor while superseded image tags held the disk. Main measures the floor; this adds eviction before the check, a build window, release-image GC and smaller release contexts."
tags: [hobo, ci, performance, deps-image, image-gc, release, storage]
---

# Finding 153: deps build window, release-image GC, and leaner release contexts

This finding was first written as "deps rebuild measured headroom, registry GC, and publisher overflow" and was numbered 87 on its branch. The measured floor reached `main` first and the publisher overflow is not part of this change; the sections below say which is which.

## Symptom

CI deps image publisher run **42907466487** and earlier runs refused local rebuilds with `refusing deps rebuild … inodes=150347 need 400000` even after a builder prune. Tagged `hobo-ci-deps` images (several GB each) dominated inode use on `/var/lib/docker`, not the BuildKit cache alone.

## Cause

`HOBO_CI_DEPS_BUILD_INODE_HEADROOM` defaulted to a fixed **400k** free inodes on a disk with about **2.1M**. That overshot the measured overlay need and blocked rebuilds on a box already running near capacity. Eviction before the build pruned the builder cache only, not superseded image tags for deps, worker and release images.

## What main already does

- **A measured floor.** `deps-build-docker-reserve.ts` holds the measured peak (175k inodes, 22 GiB) and its volatility margin; `scripts/ci/deps-build-headroom-defaults.mts` hands `build-deps.sh` the result (**210000** inodes, about **24.2 GiB**), with `HOBO_CI_DEPS_BUILD_INODE_HEADROOM` and `HOBO_CI_DEPS_BUILD_BYTE_HEADROOM` as overrides ([finding 94](./0094-deps-publisher-docker-headroom.md)).
- **Eviction when short.** Below the floor, `build-deps.sh` prunes the builder cache and then removes unused `hobo-ci-deps` images through `scripts/ci-runner-image-gc.mts` before it refuses.
- **An unrouted publisher.** The deps publisher asks for the fleet's label and has no overflow job; `packages/ci-gh-actions/test/deps-image-scope.test.ts` holds that shape.

The branch's routed publisher, its `publish-overflow` job on a GitHub-hosted runner and the `HOBO_CI_DEPS_BUILD_SPILL_OK` exit code are therefore not in this change.

## What this change adds

1. **Eviction before the headroom check.** `build-deps.sh` runs the image GC for the candidate before every build, not only once the floor is missed, and its "headroom low" line prints the floor beside the sample.
2. **A build window.** `scripts/ci/wait-deps-build-window.mts` runs before a pull-request deps build (`hobo-ci.yml`) and before the publisher's build (`publish-deps.sh`). It waits until no other job container runs, for at most `HOBO_CI_DEPS_BUILD_WAIT_MS` (5 minutes, set explicitly by both callers), then fails. Both callers run in 20-minute jobs, so the build that follows keeps the other 15.
   - It does not wait on Docker headroom. A first version also waited until the floor was met; the wait never prunes, so a box short only because of builder cache waited out its bound and failed without reaching the prune. `build-deps.sh` checks the floor once the window opens and prunes the builder cache and evicts old `hobo-ci-deps` images before it refuses.
   - A box job runs inside its own `hobo-<lease id>` container with the host's Docker socket, so the script leaves its own container out. It knows it from `HOBO_CI_HOST_JOB_DIRECTORY`, which the worker sets to the job directory named after the container, or from the host name Docker gives the container.
   - It runs before anything is installed (the job builds the image that holds `node_modules`), so it and `scripts/lib/deps-build-headroom.mts` load node builtins and repository files only. The first version read the telemetry file through the worker's zod schema and failed with `Cannot find package 'zod'` the first time a pull request needed a build; the reader is now its own few lines, checked against that schema.
   - The build step that follows is handed the job's read-only registry token (`GHCR_TOKEN`). A cluster runner has no worker image; `build-deps.sh` asks `ensure-ci-worker-image.mts` for it, and that pulls the published image only with a token. Without one the step rebuilt the base image from Debian on the runner and ran out `build.sh`'s 600 s budget.
   - A caller that is in a container it cannot identify waits `HOBO_CI_DEPS_BUILD_WAIT_UNKNOWN_SELF_MS` (2 minutes) on job containers and then proceeds, logging that one of them may be itself.
3. **Recorded peaks.** After a build, `scripts/lib/deps-build-headroom.mts --record` keeps the largest inode and byte drop seen in `$HOBO_HOME/ci/deps-build-telemetry.json` (`HOBO_CI_DEPS_BUILD_TELEMETRY_PATH`). The recorder creates the directory when it is missing; a write that fails is ignored and the build carries on. When `build-deps.sh` could only sample the Docker data root through a host mount (`host:<path>`), which `df` in the recorder cannot read, it skips recording and says so. `scripts/lib/deps-build-headroom.mts --check` raises its floor when a recorded peak is above the measured one; `build-deps.sh` still takes its floor from main's defaults.
4. **Release-image GC.** `selectWorkerImagesForDeletion` also removes superseded `ghcr.io/hobo-labs/hobo/hobo-*` tags, keeping the newest per image name. It never removes a `:candidate` tag, an image a container uses, an image a candidate tag names, or an image younger than one hour, so a release that has built and tagged an image and not yet pushed it keeps both names.
5. **Leaner release contexts.** A deploy image's `.dockerignore` leaves source maps, `test` and `__tests__` directories and named documents (`README.md`, `CHANGELOG.md`, `HISTORY.md`, `DESIGN.md`) out of the context. Two wider rules are not used: `*.test.*` dropped the `app.test.ts.tpl` starter templates `hobo` scaffolds from, and `*.md` dropped the `LICENSE.md` texts of 38 third-party packages in the `hobo-cli` image.
6. **A bounded builder cache after release builds.** `build-release-oci-image.mts` prunes with `--keep-storage` (`HOBO_RELEASE_BUILDER_CACHE_CAP`, default 2GB) instead of emptying the cache.

## Verification

- `scripts/test/deps-build-window.test.ts`: the caller's own container is left out, another job's container counts, an unidentified caller proceeds after its bound, and an idle box opens the window whatever its headroom.
- `packages/ci-gh-actions/test/image-gc.test.ts`: candidate, in-use and young release images are kept.
- `scripts/test/stage-release-oci-app.test.ts`: every path a release Dockerfile copies, every data file a workspace package ships and every licence text stays in the context.
- `scripts/test/deps-build-install-free.test.ts`: the build-window and headroom scripts import no package; `deps-build-headroom-defaults.test.ts`: the builtin telemetry reader accepts and refuses what the worker's schema does.
- `scripts/test/ci-deps-image-contract.test.ts`: eviction runs before the headroom check; the build window is wired into both paths with a 5-minute bound.
- `scripts/test/deps-build-install-free.test.ts` also saves telemetry into a directory that does not exist yet and holds the `host:` guard in front of `--record`.
- `packages/ci-gh-actions/test/deps-build-budget.test.ts`: the measured reserve and a recorded peak above it.
