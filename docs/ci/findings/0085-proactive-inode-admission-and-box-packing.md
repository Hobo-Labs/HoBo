---
type: CI Performance Finding
title: "Finding 85: proactive inode admission and box packing"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 85: proactive inode admission and box packing

## Symptom

Box workers admitted jobs from fixed slot counts while inode headroom was the real limit. Concurrent fabric jobs (~**180k** workdir inodes each) plus a deps image rebuild could exceed free inodes before admission noticed. Pruning and routing away were reactive.

## Measured reserves (before → after policy)

| Job class | Work inodes | Docker inodes | Notes |
|---|---:|---:|---|
| standard fabric (default) | **180000** | **170000** | observed workdirs (finding 58) |
| heavy (Main full gate, PR gates) | **200000** | **170000** | same docker reserve, larger trees |
| light | **80000** | **50000** | contract/scan jobs |
| deps image build | **0** | **420000** | headroom default + slack (finding 71) |
| CI runner image build | **40000** | **220000** | oci + BuildKit on docker root |

**Before:** configured `HOBO_CI_WORKER_SLOTS` only (default **2** on box). **After:** concurrent cap is `min(slots, binPackSlots(standard))` where `binPackSlots = floor((ffree − safetyMargin − outstanding) / classReserve)` on each device. **safetyMargin** is `max(HOBO_CI_STORAGE_INODE_SAFETY_MARGIN floor, volatility margin)` from `createHostCapacityTracker` (peak inode drop in a 2m window × 1.5, capped).

Example on a shared device with **900000** free inodes and no grants: bin-pack ≈ **floor((900000 − 50000) / 350000) = 2** standard jobs — aligned with old slots but now shrinks automatically as grants accumulate instead of oversubscribing.

## Fixes

1. **Proactive admission:** `storageReserveForJob(name)` applies class reserves before a lease is reserved; shortage refuses without starting the job (prune only on soft disk/inode pressure, not as the first plan).
2. **Bin-pack launches:** `storageBinPackSlots()` caps `launch()` below configured slots when inode headroom is tighter.
3. **Reliable grant release:** `onStorageGrantRelease` clears the storage grant when the workdir is retired; lease cancel paths call `release(jobId)`; deps builds use `DEPS_BUILD_ADMISSION_ID` for an explicit build-slot grant.
4. **Inode reuse:** deps Dockerfile install stage uses `pnpm` **hardlink** into the shared BuildKit store mount (final image verification keeps **copy** for offline contract checks). Jobs already hardlink from the host `/pnpm-store` and symlink `node_modules` from `/opt/hobo-deps`.
5. **Shared box / external load:** each daemon tick calls `probeHostCapacity` (live `statvfs` `ffree`/`bfree`, `/proc/meminfo` **MemAvailable**, PSI memory). Admission subtracts **outstanding grants** from observed free; it does not infer capacity from totals minus CI reservations alone. When PSI or projected headroom blocks admission, new leases wait (`isAdmissionOpen` / relay `storage` wait); running jobs are not killed.

## Verification

- `packages/ci-gh-actions/test/storage-admission.test.ts` — proactive refuse, bin-pack, safety margin, external inode drain between ticks.
- `packages/ci-gh-actions/test/host-capacity.test.ts` — volatility margin, PSI block, external drain reporting.
- `packages/ci-gh-actions/test/storage-job-classes.test.ts` — class table.
- `scripts/test/ci-deps-image-contract.test.ts` — install-stage hardlink.

Live counters: `hobo_ci_storage_capacity` (`observedFreeInodes`, `ourReservedInodes`, `maxConcurrentStandard`, …) and `hobo_ci_host_capacity` (`observedFreeInodes`, `ourReservedInodes`, `externalInodeDrain`, `memAvailableMb`, `admitNewWork`, `reason`).
