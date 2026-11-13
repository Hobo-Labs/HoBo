---
type: CI Performance Finding
title: "Finding 131: main shard trunk slot ceiling ignored parallel launch capacity"
description: "Fleet defer judged the box trunk-slot-full from the configured trunk slot count alone, ignoring the remaining memory-parallel launch room; this changes defer timing only when peers have room. The cited run 43176491360 was a no-peer-capacity hold and is not addressed here."
tags: [hobo, ci, performance, main-gate, shards, fleet, admission]
---

# Finding 131: main shard trunk slot ceiling ignored parallel launch capacity

## Evidence (before)

Main Fabric run [43176491360](https://github.com/Hobo-Labs/HoBo/actions/runs/43176491360) on `f2bd06ddf`
prompted the review, but it is **not** fixed by this change:

- **Main workspace test shards 0 and 2** logged `holdReason=no-peer-capacity` (ARC **0**, mesh **1**) until shard **1** finished (~**3m45s** after plan).
- `evaluateMainTrunkFleetDefer` returns `no-peer-capacity` whenever `peerAbsorbSlots <= 0`, **before** `slotsFull` is consulted, so the trunk slot ceiling played no part in that hold. Why the mesh witness yielded zero peer absorb slots is a separate question left open here.

## Cause

`evaluateMainTrunkFleetDefer` computed `slotsFull` as `localTrunkReserved >= trunkSlots`, using the configured trunk slot count (**1**) only. With #1926, the box can still launch more trunk shards while `parallelLaunchCapacity()` (`mainShardParallelLaunchCapacity`) reports room. That value is the number of **additional** standard jobs that fit in available memory now, not a total, so the box's real ceiling is `localTrunkReserved + parallelLaunchCapacity` (the same shape as `effectiveParallelLaunchSlots`).

Effect, only when peers **do** have room (`peerAbsorbSlots > 0`): after one local trunk reservation the box was classified slot-full and `peerImmediate` handed the next shard to peers at once, even when memory admitted it locally.

## Fix

- The relay passes `parallelTrunkLaunchCapacity` into `evaluateMainTrunkFleetDefer` (relay-internal; no fleet state reaches workflows, per ADR-0180).
- Ceiling is `max(trunkSlots, localTrunkReserved + max(0, parallelTrunkLaunchCapacity))`; `slotsFull` is `localTrunkReserved >= ceiling`, so immediate peer hand-off fires only once memory has no room for another launch.
- `no-peer-capacity` holds are unchanged.

## Measure (expected after)

On main pushes where peers report absorb slots and box memory admits more than one shard, extra shards reserve locally instead of being handed to peers immediately after the first local reservation (`hobo_ci_trunk_fleet_defer_decision` logs show `holdReason=no-wait` rather than an immediate defer). Runs held on `no-peer-capacity`, like 43176491360, are expected to look the same.

## Verification

- **TypeScript:** `packages/ci-gh-actions` typecheck + `trunk-fleet-defer.test.ts` (room beyond reservations, reservations equal to room, no room left, no-peer-capacity unchanged).
- **Protobuf / CUE / PACT:** not applicable (relay defer heuristic only).
