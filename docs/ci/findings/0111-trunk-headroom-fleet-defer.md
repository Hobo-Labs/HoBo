---
type: CI Performance Finding
title: "Finding 111: trunk headroom fleet defer"
description: "Box held 4096 MiB workspace shards under memory admission while mesh had ARC slots; Main runs breached the 20-minute job rule."
tags: [hobo, ci, performance, main-gate, memory, fleet, shards]
---

# Finding 111: trunk headroom fleet defer

## Evidence

Main Fabric runs [43055641033](https://github.com/Hobo-Labs/HoBo/actions/runs/43055641033) (**22m01s**) and [43075637251](https://github.com/Hobo-Labs/HoBo/actions/runs/43075637251) (>20m on `3513b71d5`) failed the **20-minute** job timeout rule. Heavy **Main workspace test shard** jobs (standard **4096 MiB** class) stayed on the box under host-memory admission **4–10 minutes** each while only **~2.4–3.3 GiB** MemAvailable remained; shards ran **serially** and were not offered to mesh **`arcFreeSlots`** (ARC `hobo-runner-*` / `hobo-trunk-runner-*`, peer boxes). Run `43075637251` also showed **deps-finished → Main workspace plan** gaps on the order of **minutes** when reserved launch order ignored fabric phase.

## Cause

1. **Fleet defer (#1883) only on full local trunk slots** — headroom/storage-blocked shards still reserved locally once a slot freed, pinning admission while peers sat idle.
2. **Cooperative release only for slot-full unlaunched paths** — memory waits did not trigger the same **`cancelAndRequeue`** / skip-reserve cooperative path when **`arcFreeSlots > 0`** within the **`HOBO_CI_UNLAUNCHED_*`** cooldown window.
3. **Plan pickup on reserved leases** — `mainFabricTrunkPhase` applied to the pending queue but reserved launch ordering lacked **`jobName`/labels**, so **Main full gate** could launch before **Main workspace plan** on the same push.

## Fix

- **`HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS`** (default **45000**): after headroom or storage wait, skip local reserve (fleet-capacity) or **`cancelAndRequeue`** unlaunched trunk custody when mesh has room — same cooldown/min-age as [finding 106](../0106-unlaunched-release-churn.md); log **`hobo_ci_trunk_headroom_fleet_defer`**. No workflow **rerun** (retire box **`HOBO_CI_TRUNK_HEADROOM_OVERFLOW_MS`** rerun path on the main daemon).
- **Reserved launch** passes **`jobName`** and runner label into **`admissionOrder`** so plan precedes full gate before shard launch.

## Measure

Next main Fabric push on a memory-thin box with **`arcFreeSlots ≥ 2`**: parallel workspace shard pickup without serial **4–10 min** box holds; **plan start − deps complete** under **~30s** when image is warm; no run exceeds **20 minutes** solely from box-serialized shards. Telemetry: **`hobo_ci_trunk_headroom_fleet_defer`**, **`hobo_ci_trunk_wait`** `reason=fleet-capacity` after headroom/storage age ≥ defer ms.
