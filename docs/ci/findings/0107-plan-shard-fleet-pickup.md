---
type: CI Performance Finding
title: "Finding 107: plan shard fleet pickup"
description: "Main workspace plan waited behind Main full gate for local trunk reservation; shard 1 queued on the box while ARC had mesh headroom."
tags: [hobo, ci, performance, main-gate, planning, shards, fleet]
---

# Finding 107: plan shard fleet pickup

## Evidence

Main push run [43033874249](https://github.com/Hobo-Labs/HoBo/actions/runs/43033874249) on `059792c6a` (post-#1882): **14m14s** wall, no unlaunched churn. **Main workspace plan** started **~3m** after **CI deps layer** finished though **Main full gate** had already started; **shard 1** started **~3m15s** after **shard 0** with `hobo_ci_trunk_wait` / box lease pressure while other fleet runners had capacity.

## Cause

1. **Plan pickup** — `createAdmissionOrder` sorted same-run jobs by **expected duration** before fabric role, so **Main full gate** (long S0) won the single local **trunk slot** ahead of **Main workspace plan** (short, install-free).
2. **Shard skew** — With `HOBO_CI_WORKER_TRUNK_SLOTS=1`, the box reserved multiple **Main workspace test shard** jobs locally instead of deferring overflow to **ARC/peer** slots reported in `arcFreeSlots`.

## Fix

- **`mainFabricTrunkPhase`** in `admission-order.ts`: plan → full gate → workspace shards on the same Fabric run (before duration ties).
- **`HostedRelay` fleet deferral**: when `trunkReserved >= trunkSlots`, `arcFreeSlots > 0`, and the job is a workspace shard, skip local reserve (`hobo_ci_trunk_wait` `reason=fleet-capacity`). Wire `trunkSlots` from the daemon.
- **Headroom/storage defer** ([finding 111](0111-trunk-headroom-fleet-defer.md)): same cooperative path after **`HOBO_CI_TRUNK_HEADROOM_FLEET_DEFER_MS`**; reserved launch uses `jobName` for fabric phase ordering.

## Measure

Next green main Fabric push: **plan start − deps layer complete** under **~30s** when runner image is ready; **shard 1 start − shard 0 start** under **~60s** when `HOBO_CI_FLEET_CAPACITY` admits ≥2 parallel trunk slots (target from run 43033874249 baseline).
