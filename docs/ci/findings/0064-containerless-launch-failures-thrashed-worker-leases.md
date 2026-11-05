---
type: CI Performance Finding
title: "Finding 64: containerless launch failures thrashed worker leases"
description: "Repeated silent launch failures removed large job work directories, consumed host inodes, and blocked admission with phantom memory reservations."
tags: [hobo, ci, performance]
---

# Finding 64: containerless launch failures thrashed worker leases

## Evidence

PR #1728's jobs stayed queued while the box worker repeatedly admitted work without running it. A job reserved memory and a lease, prepared its roughly **3.3 GB / 180,000-entry** work directory, failed before it had a container, logged `hobo_ci_work_dir_removed`, and was admitted again. One earlier deps-layer job was admitted at least **eight times**. The repeated directory creation and deletion pushed box inode use to **89%**.

`hobo_ci_memory_without_containers` was also observed with `activeLeaseCount > 0` and zero containers. Reservations left behind while launch slots were full consumed admission memory even though no container was expected for them yet.

## Cause

The bare `catch` around container launch aborted and requeued the job without recording the failing operation. The next tick leased the same job again, so a persistent create, start, transition, JIT-registration, or runner-start error became an invisible work-directory churn loop.

Lease reconciliation measured its two-minute missing-container grace from `createdAt`. A lease that had waited twenty minutes for memory was therefore already beyond grace when dispatch began. The reconciler also treated `reserved` leases as missing containers even though they have no container by design, and it could delete a work directory while launch was still using it in the same process.

Swapped-runner recovery added another source of duplicate demand: when the runner leased for job A was observed running job B, the relay queued A again without first checking whether this worker already had an idle, matching runner available to take A.

## Fix

Every launch failure now emits `hobo_ci_launch_failed` with `stage`, `message`, `leaseId`, `jobId`, `actualJobId`, and the attempt count. Stages cover preparation, image selection, container create/start, store transitions, JIT registration, and runner start.

`Lease.dispatchingAt` records entry into `dispatching`. Missing-container grace for `dispatching`, `dispatched`, and `claiming` leases starts at that timestamp rather than reservation creation. Reserved leases are not container-missing candidates, and in-process in-flight launch IDs protect both their leases and work directories from reconciliation.

Memory admission counts launched or launching work; untouched slot-waiting reservations no longer block new work with phantom container memory. The journal-only memory warning uses the same accounting.

Three launch failures for the same `(repositoryId, jobId, runAttempt)` within thirty minutes now park that job for ten minutes. The third failure emits `hobo_ci_launch_parked` with the last failure and counts, cancels the active lease without creating replacement demand, and releases its container resources and work directory. Admission skips the parked job until its GitHub state changes or the park expires. This in-memory loop guard does not change normal retry behavior.

Swapped-job recovery now checks registered runners directly. It does not queue fresh demand for A when a running, unassigned lease has an idle GitHub runner with the same label. Ambiguous runner reads fail closed toward the existing requeue behavior.

## Verification

The launch-thrash Vitest scenario uses the real SQLite store and hosted relay. It drives three admissions for one job, proves that each creates and removes a work directory without creating a container, and verifies the parked log, released lease, suppressed fourth admission, and admission after ten minutes. Further tests cover stage-aware failure logging, old reserved leases, a twenty-minute-old lease immediately after dispatch starts, in-flight work-directory protection, slot-waiting memory exclusion, and suppression of duplicate swapped-job demand when an idle matching runner exists. Existing reconciliation fixtures now distinguish reserved leases from dispatching leases whose grace has expired.
