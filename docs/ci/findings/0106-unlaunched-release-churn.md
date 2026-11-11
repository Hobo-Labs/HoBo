---
type: CI Performance Finding
title: "Finding 106: unlaunched release churn"
description: "Post-#1879 admission-backlog release fired every 1–3s without ARC/peer headroom, causing reserve/cancel loops while GitHub jobs stayed queued."
tags: [hobo, ci, performance, worker, admission, fleet, cooperation]
---

# Finding 106: unlaunched release churn

## Evidence

Main push run [43030073696](https://github.com/Hobo-Labs/HoBo/actions/runs/43030073696) on `52dabd9d3`: shards 0–2 queued on GitHub without a runner while shard 3 started on ARC. Box worker logged dozens of **`hobo_ci_unlaunched_reservation_released`** (`reason=admission-backlog`, `pendingDemand=5`) within seconds, interleaved with **`hobo_ci_memory_admission_wait`** (`reason=host-available`). Jobs were reserved then released before ARC had mesh-reported free slots.

## Cause

**#1879** released unlaunched reservations when **`pending + unlaunched > launchSlots − liveContainers`** after **one tick of age** (`ageMs > 0`), including a release pass at the **start** of every dispatch. Under foreign memory load, local launch never started, **`arcFreeSlots` was 0**, and cancel/requeue immediately re-reserved the same jobs — churn without handing custody to ARC.

## Fix

- Release only when **`arcFreeSlots` (mesh non-local capacity) > 0** so another runner can absorb work.
- **`backlogMinAgeMs`** defaults to the launch bound (not one tick); remove pre-reserve release pass.
- Per-job **`reReserveCooldownMs`** after release; bypass when mesh headroom increases.
- Log **`releaseCount`** and **`nonLocalFreeSlots`** on **`hobo_ci_unlaunched_reservation_released`**.

## Measure

Next multi-shard main push under box memory pressure: **no burst of release events** without concurrent **`arcFreeSlots > 0`**; queued shards reach ARC or launch when headroom returns without 80+ releases per job.
