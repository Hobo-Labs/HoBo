---
type: CI Performance Finding
title: "Finding 87: deps rebuild measured headroom, registry GC, and publisher overflow"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 87: deps rebuild measured headroom, registry GC, and publisher overflow

## Symptom

CI deps image publisher runs **42907466487** and earlier refused local rebuilds with `refusing deps rebuild … inodes=150347 need 400000` even after builder prune. Tagged `hobo-ci-deps` images (multi‑GB) dominated inode use on `/var/lib/docker`, not BuildKit cache alone.

## Cause

`HOBO_CI_DEPS_BUILD_INODE_HEADROOM` defaulted to a fixed **400k** free inodes (~**81%** of a **2.1M** inode disk). That overshot the measured overlay need and blocked rebuilds on a box already running near capacity. Pre-build eviction pruned cache only, not superseded registry tags for deps, worker, and release OCI candidates.

## Fix

- `deps-build-budget.ts` + `scripts/lib/deps-build-headroom.mts`: required headroom = measured peak × volatility (default ~**210k** inodes), with optional telemetry and explicit env overrides.
- `build-deps.sh`: registry GC via `ci-runner-image-gc.mts` (deps + worker + release candidates) before refusing; exit **2** with `HOBO_CI_DEPS_BUILD_SPILL_OK=1` for publisher overflow.
- `.github/workflows/ci-deps-publish.yml`: route job + `publish-overflow` on `ubuntu-24.04` when the box is still short.
- Release OCI: tighter `.dockerignore` for deploy staging and `docker builder prune --keep-storage` after builds.

## Verification

`packages/ci-gh-actions/test/deps-build-budget.test.ts`, `image-gc.test.ts` (release candidates), `deps-image-scope.test.ts`, and `scripts/test/ci-deps-image-contract.test.ts`.
