---
type: CI Performance Finding
title: "Finding 131: main shard trunk slot ceiling ignored parallel launch capacity"
description: "Run 43176491360 held shards 0 and 2 on no-peer-capacity while shard 1 ran despite mesh reporting spare capacity and OS headroom allowing parallel standard shards."
tags: [hobo, ci, performance, main-gate, shards, fleet, admission]
---

# Finding 131: main shard trunk slot ceiling ignored parallel launch capacity

## Evidence (before)

Main Fabric run [43176491360](https://github.com/Hobo-Labs/HoBo/actions/runs/43176491360) on `f2bd06ddf`:

- **Main workspace test shards 0 and 2** logged `holdReason=no-peer-capacity` (ARC **0**, mesh **1**) until shard **1** finished (~**3m45s** after plan).
- Wall-critical path ~**3 min** despite #1926 memory-parallel launch policy on the box.

## Cause

`evaluateMainTrunkFleetDefer` treated `localTrunkReserved >= trunkSlots` as **slots full** using the configured trunk slot count (**1**) only. `#1926` can admit multiple trunk-labelled shards when `parallelLaunchCapacity()` &gt; 1, but fleet defer still classified the box as full after the first reservation—pushing shards toward mesh defer while `peerAbsorbSlots` was **0** (local free slot double-counted in mesh witness), serializing work.

## Fix

- Pass `parallelTrunkLaunchCapacity` from the relay into `evaluateMainTrunkFleetDefer`.
- `slotsFull` uses `max(trunkSlots, parallelTrunkLaunchCapacity)` so cooperative defer fires only after parallel box capacity is exhausted.

## Measure (expected after)

On the next main push with `parallelLaunchCapacity >= 2` and sufficient MemAvailable:

- Shards **0** and **2** reserve locally while shard **1** runs when memory admits, instead of waiting for shard **1** completion solely due to a one-slot defer ceiling.

## Verification

- **TypeScript:** `packages/ci-gh-actions` build + `trunk-fleet-defer.test.ts`, `github-job-poller.test.ts` parallel-shard case.
- **Protobuf / CUE / PACT:** not applicable (relay defer heuristic only).
