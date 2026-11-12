---
type: CI Performance Finding
title: "Finding 58: two concurrent jobs exhausted inodes mid-run"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 58: two concurrent jobs exhausted inodes mid-run

Main push run **41912562504** (**#1719**) failed when Turbo hit `ENOSPC` for inodes in Workspace tests on the self-hosted `hobo` box. Operator measurement attributed about **180000** inodes per isolated-worker job to the host work directory (`workRoot`) and about **150000** to the container writable layer (`dockerDataRoot`). Admission checked only current soft (**85%**) and hard (**95%**) usage ratios. Two jobs could therefore both pass while the box had enough current headroom, then grow together and exhaust inodes mid-run.

Admission now records each successful job grant and reserves expected growth before reserving a lease. Defaults are **200000** workdir inodes and **170000** container inodes per job, set by **`HOBO_CI_WORKER_WORKDIR_INODES`** and **`HOBO_CI_WORKER_CONTAINER_INODES`**. Values must contain digits only and fit a non-negative safe integer; invalid values fail daemon startup, unset values use the defaults, and **0** disables that root's reservation. Byte-based admission and the existing usage-ratio checks are unchanged.

For each filesystem device, admission requires `freeNow - outstanding >= reserveForThisJob`. Outstanding growth is the live grants' combined reserve minus consumption observed since the oldest live grant, clamped at zero. When both roots share a device their reserves add; different devices are checked independently. A shortage triggers one maintenance pass and resample before the job waits. `hobo_ci_inode_reserve_wait` logs the root, free and outstanding inodes, required reserve, and active grant count once per episode. Grants whose jobs have no active lease expire after a **60-second** grace, while a grant whose subsequent memory or lease reservation fails is released immediately. Reconciliation uses the job for which the lease was admitted, not a swapped actual job.

Regression coverage uses scripted filesystem free-inode samples and device IDs for consecutive admission, observed consumption, independent devices, release, grace expiry, disabled reserves, invalid configuration, and relay release after a null lease reservation. Grants bind to the lease id on successful `store.reserve` and `releaseWorkerStorageGrants` runs on every lease terminal path (cancel, requeue, expire, settle, launch abort) so rapid reserve→cancel cycles cannot stack headroom in `grants`. **Not verified here:** this sandbox has no Docker daemon or self-hosted box, so no live concurrent job run or production inode measurement was repeated. The **180000/150000** figures are the operator's measurements; the **200000/170000** defaults are conservative reservations derived from them.
