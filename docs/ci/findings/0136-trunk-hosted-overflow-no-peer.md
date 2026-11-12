---
type: CI Performance Finding
title: "Finding 136: trunk hosted overflow no peer"
description: "Main workspace shards stayed on hobo-trunk for 8+ minutes under memory headroom while ARC reported 0 free slots and GitHub-hosted never took the work."
tags: [hobo, ci, performance, main-gate, memory, fleet, overflow, github-hosted]
---

# Finding 136: trunk hosted overflow no peer

## Evidence

Main Fabric run [43183884926](https://github.com/Hobo-Labs/HoBo/actions/runs/43183884926) on `38d4b73eb` trended past **20 minutes**. After a **6m43s** **Main workspace plan**, shards **0–2** remained **queued ~8 minutes** on `hobo-trunk` while the box correctly refused **4096 MiB** class work (**~2.4–5 GiB** MemAvailable vs **7168 MiB** need). Mesh/`HOBO_CI_FLEET_CAPACITY` showed **`arc.freeSlots: 0`**; GitHub-hosted never picked up.

## Cause

**Main workspace test** jobs hardcoded **`hobo-trunk`** at queue time. When mesh ARC was empty and trunk memory headroom was false, shards still requested a label the box could not launch, with no plan-time escape to GitHub-hosted.

## Fix

- Worker **`HOBO_CI_FLEET_CAPACITY`** snapshots add **`trunkMemoryAdmit`** from `memoryAdmitHeadroom` on the **standard (4096 MiB)** shard class with **2048 / 1024 MiB** reserve and volatility unchanged.
- **`main-gate-plan`** plans shard indexes only (plan can exceed **5 minutes**; e.g. **6m43s** in evidence). A follow-up **Emit workspace shard matrix** step inlines **`vars.HOBO_CI_FLEET_CAPACITY`** as **`HOBO_CI_FLEET_CAPACITY_JSON`** so freshness is evaluated **after** planning (not the REST variables API; [finding 0117](../findings/0117-shard-limit-below-the-planned-shard.md)).
- **`shard_matrix`**: per-shard **`runner`** — **`hobo-trunk`** for indices covered by **`arc.freeSlots`** when **`trunkMemoryAdmit === false`**, else **`ubuntu-24.04`** (GitHub-hosted machine type, not bare **`hobo`**). Stale **`publishedAt`** (**> 5 minutes**) → all **`hobo-trunk`** (hold, no overflow).
- **`main_workspace_tests`** matrix **`include`** + **`matrix.runner`** on push, **`schedule`**, dispatch, merge_group, and workflow_run (no workflow rerun, no repo-wide **`HOBO_CI_FLEET_ROUTES`** flip; shared **`hobo`** fleet label unchanged).

## Measure

On a memory-thin box with **ARC 0** and fresh capacity: overflow shards queue on **`ubuntu-24.04`** at plan time when **`trunkMemoryAdmit: false`**, not after **8+ minutes** stuck on **`hobo-trunk`**.

## Verified

- `packages/ci/test/fleet-capacity-input.test.ts`
- `pnpm run test:smoke scripts/test/load-fleet-capacity.test.ts`
- `pnpm run test:smoke scripts/test/main-gate-workspace-shards.test.ts`
- Stale or malformed capacity snapshots fall back to default parallel cap; plan cache key includes `hash(vars.HOBO_CI_FLEET_CAPACITY)` plus manifest `parallelCap`.
