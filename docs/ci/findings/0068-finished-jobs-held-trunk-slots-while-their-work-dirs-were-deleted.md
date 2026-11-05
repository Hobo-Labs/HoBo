---
type: CI Performance Finding
title: "Finding 68: Finished jobs held trunk slots while their work dirs were deleted"
description: "Inline multi-GB work-directory deletion and repeated storage maintenance delayed trunk admission on a nearly idle box."
tags: [hobo, ci, performance]
---

# Finding 68: Finished jobs held trunk slots while their work dirs were deleted

## Evidence

Main push run **41969850207** (HoBo CI Fabric, #1731) created the `Main full gate` job on `hobo-trunk` at **04:46:18**, but the job did not start until **04:49:15**: about **177 seconds** waiting for a gate that itself ran **54 seconds**. `CI deps layer (pnpm)` finished at **04:46:58**, leaving another **137 seconds** of gate delay. Across all runs, GitHub showed only one or two hobo jobs running between 04:46:58 and 04:49:15. Job starts arrived at 04:46:49, 04:47:26, 04:48:29, 04:48:51 and 04:49:15, roughly once per minute despite the nearly idle box.

## Cause

Two inline paths delayed admission:

1. **Finished-job cleanup blocked the relay tick.** Container reconciliation awaited a complete `lstat` walk to measure every work-directory entry and byte, then awaited a second recursive traversal to delete the multi-GB, roughly 200,000-inode tree. The same deletion ran in lease-release and launch-failure cleanup. Until reconciliation finished, `dispatchPending()` could not admit the next job, so a trunk-labelled job could wait even though its runner slot was otherwise free.
2. **One storage refusal repeated host-wide maintenance.** `dispatchPending()` called storage admission for every pending job. Under soft pressure or an inode-reserve shortage, each call ran builder pruning, image listing/removal, dangling-image pruning and orphan work-dir reaping. Storage pressure is host-wide, so later jobs in the same pass paid for the same maintenance only to be refused again. A storage-refused trunk-label job also skipped the existing lower-rank barrier and trunk-wait evidence.

## Fix

Finished or orphaned job directories are now atomically renamed inside the work root to `.retired/<job>-<timestamp>`. This frees the original job path without walking the tree. A single-flight background sweeper deletes retired entries one at a time; triggers during a sweep coalesce into one rerun. Startup and scheduled GC trigger the sweeper, drain-mode shutdown awaits it, and handoff mode leaves remaining work for the successor's startup sweep. Deletion itself is one bottom-up traversal that counts bytes and entries as it removes them.

Storage admission still grants inode reservations per admitted job, but a dispatch pass stops calling it after the first refusal. Admission-triggered maintenance is limited to once per 60 seconds, with a fresh storage sample on every decision. A trunk-label storage refusal blocks lower ranks and records `hobo_ci_trunk_wait` with `reason: "storage"`.

The runtime measures delivery, lease-reconciliation and dispatch phases. The daemon adds worker reconciliation time and logs slow ticks instead of relying on job-start timestamps alone.

## Verification

Unit tests cover atomic retirement and missing sources, one-traversal deletion and accounting, sweeper single-flight/rerun/error behavior, reconciliation that does not await removal, one storage admission attempt per dispatch pass, trunk storage refusal, maintenance rate limiting and tick phase timings.

On the box, inspect:

- `hobo_ci_work_dir_retired` with `{jobId, leaseId, ms}` to confirm cleanup leaves the tick after the atomic rename.
- `hobo_ci_work_dir_removed` with `{path, bytes, entries, ms}` and `hobo_ci_work_dir_remove_failed` to follow background deletion.
- `hobo_ci_isolated_worker_tick_slow` with `{totalMs, deliveriesMs, leaseReconcileMs, dispatchMs, workerReconcileMs, leaseCount, pendingCount}` when a tick exceeds five seconds.
- `hobo_ci_trunk_wait` with `reason: "storage"` to distinguish host storage pressure from lease capacity.

No box deploy or live CI run was performed for this finding.
