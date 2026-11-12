---
type: CI Performance Finding
title: "Finding 127: light trunk plan and immediate fleet pickup for deps"
description: "Run 43172214692 (05457ecf3) waited ~2m45s for plan and deps after a 15s route leg."
tags: [hobo, ci, performance, main-gate, admission, fleet, memory-class]
---

# Finding 127: light trunk plan and immediate fleet pickup for deps

## Evidence (before)

Main Fabric run [43172214692](https://github.com/Hobo-Labs/HoBo/actions/runs/43172214692) on `05457ecf3` (**9m12s** wall):

| Leg | Queue → start | Job time |
| --- | --- | --- |
| Route runners | — | ~15s |
| CI deps layer (pnpm) | **~2m49s** after route | ~9s |
| Main workspace plan | **~2m42s** after route | ~19s |

Box MemAvailable peaked near **~8.1 GiB** (~1:04 AM CST) while those jobs still held for a **4096 MiB-class** admission slot. ARC / mesh fleet runners had capacity but did not absorb plan or deps during the memory-headroom wait (finding 119 shortened defer for peers but **memory-headroom** still required the cooperative window for non-shard trunk jobs).

Hard rules: no standard/heavy class floor reduction (4096 / 2048 / 1024 unchanged); no runner relabel; no cancel/rerun logic.

## Cause

1. **Main workspace plan** had no explicit memory mapping and defaulted to **standard** (4096 MiB unmeasured reservation) despite being a short Node-only planning step.
2. **CI deps layer** correctly keeps the **4096 MiB heavy floor** for Docker peaks, but when the box blocked on **memory-headroom**, cooperative fleet defer treated it like overflow shards—**peerImmediate** did not include memory-headroom, so ARC/mesh pickup waited up to 45s (5s when peers were visible) even though the job runtime is seconds.

## Fix

- **`memory-classes.ts` / `storage-job-classes.ts`** — map **Main workspace plan** to the **`light`** memory and storage classes (1024 MiB unmeasured reservation; standard class sizes unchanged).
- **`trunk-wait.ts`** — when peers report absorb slots, **Main workspace plan** and **CI deps layer (pnpm)** defer immediately on **`memory-headroom`** (same path as cpu-contention / full trunk slots), so fleet runners can start the job without a multi-minute box hold.

## Measure (expected after)

On the next memory-thin main Fabric push with warm route and `arcFreeSlots ≥ 1`:

- **Main workspace plan** and **CI deps layer** start within **~15s** of **Route runners** completing (local light admit or immediate fleet defer).
- **CI deps layer** container limit remains **≥4096 MiB**; **Main full gate** and shards unchanged.

Telemetry: `hobo_ci_trunk_fleet_defer_decision` (`waitReason=memory-headroom`, `action=defer` without `holdReason=wait-too-short`), `hobo_ci_memory_admitted` / `hobo_ci_memory_admission_wait` for plan with `memoryClass=light`.
