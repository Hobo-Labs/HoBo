---
type: CI Performance Finding
title: "Finding 84: deps rebuild overlapped isolated jobs and exhausted inodes"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 84: deps rebuild overlapped isolated jobs and exhausted inodes

## Symptom

CI deps image publisher run **42838687335** failed with `ENOSPC` from inode exhaustion on the box. Docker's data root was about **94%** full while two Fabric jobs still held large work directories (~**180k** inodes each). A concurrent deps rebuild (daemon ensure loop or publisher `build-deps.sh`) needed hundreds of thousands more inodes than `HOBO_CI_DEPS_BUILD_INODE_HEADROOM` allows.

## Cause

Finding 71 added a headroom guard inside `build-deps.sh`, but the daemon deps ensurer could still start a local build while `activeLeases` were non-empty. The publisher workflow called `build-deps.sh` on a key miss without waiting for isolated job containers to finish. Pre-build image GC ran only after a successful build, not before a new one.

## Fix

- `createDepsImageEnsurer` accepts `idleForBuild`; the box daemon sets it to defer when any lease is active.
- `build-deps.sh` runs `scripts/ci-runner-image-gc.mts` on the candidate tag immediately before `ensure_deps_build_headroom`.
- `scripts/ci/wait-deps-build-window.mts` waits until no `hobo-<uuid>` job containers run and free inodes meet the deps headroom default; the publisher workflow and `publish-deps.sh` call it before a miss build.

## Verification

`packages/ci-gh-actions/test/isolated-worker-deps-image-ensure.test.ts` covers idle build deferral. `scripts/test/ci-deps-image-contract.test.ts` still pins builder-only pruning and the headroom call site before `docker build`.
