---
type: CI Performance Finding
title: "Finding 151: deps image builds take a storage grant on an idle box"
description: "Box jobs were admitted by slot count while inode headroom was the real limit; a deps image rebuild beside running jobs could exhaust it. Main now admits by per-device grants; this adds a grant and an idle gate for the daemon's own deps build."
tags: [hobo, ci, performance, admission, storage, deps-image]
---

# Finding 151: deps image builds take a storage grant on an idle box

This finding was first written as "proactive inode admission and box packing" and was numbered 85 on its branch. Most of that design reached `main` in a different form before the branch merged; what is left here is the part `main` did not have.

## Symptom

Box workers admitted jobs from fixed slot counts while inode headroom was the real limit. Concurrent fabric jobs (about **180k** workdir inodes each, [finding 58](./0058-two-concurrent-jobs-exhausted-inodes-mid-run.md)) plus a deps image rebuild could exceed free inodes before admission noticed. Pruning and routing away were reactive.

## Measured reserves

These are the per-class reserves admission uses today. They live in `packages/ci-gh-actions/src/isolated-worker/storage-job-classes.ts` on `main`.

| Job class | Work inodes | Docker inodes | Notes |
|---|---:|---:|---|
| standard fabric (default) | **180000** | **170000** | observed workdirs (finding 58) |
| heavy (Main full gate, PR gates) | **200000** | **170000** | same docker reserve, larger trees |
| light | **80000** | **50000** | contract and scan jobs |
| deps image build | **0** | **210000** | measured overlay peak 175k × 1.2 ([finding 71](./0071-a-deps-key-miss-rebuilt-without-inode-headroom.md)) |
| CI runner image build | **40000** | **220000** | oci and BuildKit on the docker root |
| release trunk | **220000** | **200000** | pages, npm install and site dist ([finding 90](./0090-release-enospc-byte-admission.md)) |

## What main already does

- **Per-class reserves before a lease is reserved.** `storageReserveForJob(name)`, scaled by learned peaks in `storage-peaks.ts`, is passed to `admit(leases, jobId, reserve)`.
- **Per-device inode and byte grants.** `storage-admission.ts` keeps one grant per job and device, nets out what the jobs have already consumed, and counts a shared device once ([finding 90](./0090-release-enospc-byte-admission.md), [finding 100](./0100-inode-grant-idle-reconcile.md), [finding 105](./0105-per-job-workdir-inodes.md)).
- **Grant release.** The relay and the controller release a job's grants on every path that ends its lease, a reservation cancelled at pre-flight included.
- **Host pressure.** Memory, PSI and load are read by `host-health.ts`, `host-resource-pressure.ts` and memory admission ([finding 142](./0142-box-admission-counted-neither-promised-memory-nor-lasting-headroom.md)); new work waits and running jobs are not killed.

The branch's own admission rewrite (a safety margin from observed volatility, refusing before pruning, a bin-packed launch cap, a host-capacity tracker blocking on memory PSI) is not part of this change. `host-capacity.ts` is kept as a module with its tests and is not called by the daemon.

## What this change adds

1. **The daemon's deps build waits for an idle box.** `createDepsImageEnsurer` takes `idleForBuild`; the daemon answers true only with no active lease. A busy box backs the build off for `idleBuildRetryMs` (60 s) instead of building beside jobs.
2. **The build holds a storage grant.** `onBuildSlot.acquire` asks main's admission for `storageReserveForDepsBuild()` under `DEPS_BUILD_ADMISSION_ID`, and `release` runs in a `finally`. The build has no lease, so `reconcile` leaves that one grant alone until it is released; a job admitted while the build runs is measured against the build's remaining reserve.
3. **Hard links in the install stage.** The deps Dockerfile installs with `npm_config_package_import_method=hardlink` from the BuildKit store mount; the final image keeps `copy` for the offline contract check.

## Verification

- `packages/ci-gh-actions/test/isolated-worker-deps-image-ensure.test.ts`: a local build defers while leases are active.
- `packages/ci-gh-actions/test/storage-admission.test.ts`: the deps build grant outlives the reconcile grace and frees headroom on release.
- `packages/ci-gh-actions/test/storage-job-classes.test.ts`: the class table.
- `scripts/test/ci-deps-image-contract.test.ts`: the install stage hard-links.
- `packages/ci-gh-actions/test/host-capacity.test.ts`: the unwired tracker module.
