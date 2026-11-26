---
type: CI Performance Finding
title: "Finding 116: main shard timeout — CPU admission"
description: "Four concurrent 4096 MiB trunk jobs on a four-core box with ~2 GiB free and ~430% CPU on one container hit GitHub's 20-minute job timeout without assertion failure."
tags: [hobo, ci, performance, main-gate, cpu, memory, fleet, shards]
---

# Finding 116: main shard timeout — CPU admission

## Evidence

Main Fabric run [43130657460](https://github.com/Hobo-Labs/HoBo/actions/runs/43130657460) on `4c4db7036` (**2025-11-11**) timed out: **Main workspace test shard 1** breached GitHub's **20-minute** job limit between **7:16–7:37 PM CST** with **no failing assertion**. The **full gate** (~16m40s), **shard 0** (~15m16s), **shard 2** (~14m13s), and **shard 1** ran **together** in **4 GiB** containers on the shared box while **~2 GiB** host memory stayed free (external work consumed most RAM) and one container reported **~430% CPU**. Prior main runs on the same box often finished in **4–14 minutes**.

## Cause

Memory-only admission (MemAvailable, PSI, budget) allowed **full gate + three workspace shards** to co-schedule even when **1-minute load + reserved standard-class containers** already accounted for roughly **four cores**. Contention stretched shard runtime past the workflow job timeout without changing test outcomes.

## Fix

- **CPU admission** on standard-class and heavier jobs: `cores - load1 - (heavyLeases × 4) - volatility < 4` → `reason: cpu-contention`, logged with `cpuCores`, `cpuLoad1`, `cpuReserved`, `cpuHeadroom`, … on `hobo_ci_memory_admission_wait`.
- **Trunk fleet defer**: `cpu-contention` joins the headroom defer reasons; when **`peerAbsorbSlots > 0`**, main trunk jobs **defer immediately** to ARC/mesh without waiting **`HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS`**; otherwise defer after the window. Decision events: **`hobo_ci_trunk_fleet_defer_decision`**.
- **Held-job pruner bootstrap**: on daemon start, **`refreshHeldPruneWitnessFromStore`** + **`maybePrune(true)`** clears pending holds for runs already **completed/cancelled** on GitHub when poll lookback missed them (e.g. runs `43107920330`, `43111719541` after worker redeploy).

## Measure

On a loaded four-core box: at most **one additional** standard trunk container admits when load and peers imply **&lt; 4 CPUs** headroom; overflow shards log **`trunk_wait` `cpu-contention`** then **`fleet-capacity`** when peers absorb; no **20m** timeouts solely from box CPU pile-up. Startup: stale held jobs from cancelled runs drop within the first poll cycle without babysitter-visible ghosts.
