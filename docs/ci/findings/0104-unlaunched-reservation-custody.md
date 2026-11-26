---
type: CI Performance Finding
title: "Finding 104: unlaunched reservation custody"
description: "Box worker reserved shard jobs without launching containers while admission backlog and fake dispatching inflated memory slots."
tags: [hobo, ci, performance, worker, admission, fleet, github-api]
---

# Finding 104: unlaunched reservation custody

## Evidence

Main push run [43017688406](https://github.com/Hobo-Labs/HoBo/actions/runs/43017688406) on `715206e33` (post-#1878):

| Signal | Value |
| --- | --- |
| Symptom | Shard 3 **queued ~7m**; box worker **reserved after ~174s** but **no container** |
| Backlog | **4 jobs** pending admission; duplicate box custody until **ARC** took the job (~6:17 CST) |
| Skew | Shard start spread **7m02s** (baseline **2m03s** on `4463eae34`); Plan job **85s** trunk wait |

## Cause

`reserved` leases with no sandbox still held GitHub custody while `launch()` returned early at the slot cap. The reserve pass also pushed them into `memoryActive` as **`dispatching`**, so memory/trunk admission counted phantom slots and amplified `hobo_ci_trunk_wait` even though `leaseOccupiesWorkerResources` treats plain `reserved` as free.

## Fix

- Bounded **unlaunched reservation release** after the reserve pass (`hobo_ci_unlaunched_reservation_released`): default **`HOBO_CI_UNLAUNCHED_RESERVE_MS=25000`**, plus backlog release when **pending + unlaunched > launchSlots − liveContainers** after **`HOBO_CI_UNLAUNCHED_BACKLOG_MIN_AGE_MS`**, only when **`arcFreeSlots > 0`**. Follow-up in [finding 106](0106-unlaunched-release-churn.md).
- Stop inflating `memoryActive` for `reserved`-only leases.
- `cancelAndRequeue` returns work to the inbox; fleet runners may adopt without workflow cancel or relabeling.

## Measure

On the next multi-shard main Fabric push: no shard stays **queued** on box custody for longer than the release bound while another fleet member has free slots; shard start skew returns near the post-#1878 baseline without ARC rescuing a box-reserved job.
