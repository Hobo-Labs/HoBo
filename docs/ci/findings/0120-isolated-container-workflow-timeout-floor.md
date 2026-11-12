---
type: CI Performance Finding
title: "Finding 120: isolated container workflow timeout floor"
description: "Main workspace test shard 3 failed at exactly 10m with BlobNotFound logs while GitHub job timeout-minutes is 20."
tags: [hobo, ci, shards, isolated-worker, timeout]
---

# Finding 120: isolated container workflow timeout floor

## Evidence

Main Fabric run [43146211730](https://github.com/Hobo-Labs/HoBo/actions/runs/43146211730) on `4ded66370` (**2025-11-12**): **Main workspace test shard 3** (job `130945898910`, box `hobo-trunk`) ended at **exactly 10m00s** (21:15:48–21:25:48 CST) during **Workspace tests**. GitHub shows **BlobNotFound** logs; workflow **`timeout-minutes: 20`**.

## Cause

Isolated containers label `hobo.ci/timeout-ms` from **routing `reservedMinutes`** (`account.maxRuntimeMinutes + startupMinutes`, often **10**), not the workflow job limit (**20**). The lease reconciler stops running containers past that budget (+ hard grace), which disconnects the JIT runner while GitHub still considers the job active.

## Fix

- **`workflowJobTimeoutMinutes` / `effectiveIsolatedTimeoutMs`**: floor container labels and reconciliation at known workflow limits (main workspace shards, full gate, release OCI build matrix, …).
- **Reconciler**: enforce `max(label, workflow floor)` so older **10m** labels cannot kill **20m** jobs.

## Measure

Main workspace shards on the box: no **~10m** cutoffs during **Workspace tests** when the workflow allows **20m**; `hobo_ci_container_timeout_enforced` uses **≥ 1_200_000ms** for shard jobs.
