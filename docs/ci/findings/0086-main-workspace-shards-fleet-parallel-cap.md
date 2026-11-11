---
type: CI Performance Finding
title: "Finding 86: main workspace shards fleet parallel cap"
description: "Main full gate must not plan dozens of workspace shard jobs on a three-slot box; shard count follows published fleet capacity."
tags: [hobo, ci, performance, planner, shards, capacity, main]
---

# Finding 86: main workspace shards fleet parallel cap

## Symptom

Main Fabric run [42943386212](https://github.com/Hobo-Labs/HoBo/actions/runs/42943386212)
after #1840 planned **64** `Main workspace test shard` jobs while the box admits
about three jobs at the standard memory class (4096 MiB) against roughly 13.9 GiB
budget, with ARC adding only a few slots. One shard ran; the rest queued until the
20-minute main gate timeout.

## Cause

`planShardCountBalanced` targeted 90 seconds per shard with `MAIN_SHARD_CAP=64`.
A repo-wide plan split into dozens of tiny shards, each needing its own runner
turn.

## Fix

- The worker publishes `HOBO_CI_FLEET_CAPACITY` (hobo + ARC free slots,
  `admittedParallel`) on the same cadence as fleet routes (`fleet-capacity.ts`).
- `plan-main-workspace-shards.mts` reads that variable via `load-fleet-capacity.mts`
  (Node builtins only; default parallel cap **4** when unset or invalid)
  and calls `planMainWorkspaceShardCount`, which packs several duration-balanced
  workspace groups into each of at most `admittedParallel` shard jobs
  (target **180s** slowest shard when capacity allows).
- `Main workspace test shard` jobs use standard-class memory with learned peaks
  (floor 4096 MiB, never below measured peak + margin).

## Verification

- `packages/ci/test/fleet-capacity-input.test.ts`
- `scripts/test/main-workspace-shard-capacity.test.ts`
- `scripts/test/main-gate-plan-install-free.test.ts`
- `packages/ci-gh-actions/test/fleet-capacity.test.ts`
