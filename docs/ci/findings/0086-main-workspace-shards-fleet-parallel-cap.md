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

## Measured vs expected (main push run 42968518079)

Before this fix, **Main full gate** wall time was about **500s** (~8m20s). The four
`Main workspace test shard` jobs on the critical path were **387s**, **279s**,
**274s**, and **199s** (slowest **387s**), each running a broad slice with limited
parallelism on ~three live slots.

With fleet cap default **4**, duration table weights from
[run 42951579615](https://github.com/Hobo-Labs/HoBo/actions/runs/42951579615),
**180s** slowest-shard target, turbo `--affected` vs last-green main, and
box-local turbo cache:

- **Expected** slowest shard (planner `peakShardSeconds` at cap 4 on current repo
  tree): about **120–180s** for typical doc-only or single-package pushes; repo-wide
  pushes still approach the **180s** cap per shard but run at most **four** shards
  in parallel when `HOBO_CI_FLEET_CAPACITY` admits four slots.
- **Expected** main-gate workspace leg (parallel shards, not serial queue): about
  **3–4 minutes** when four slots are live; bounded by slowest shard, not the sum
  of four shard durations.
- **Measured** post-merge: re-run main push and compare `peakShardSeconds` in
  `main-gate-plan` logs with the slowest shard job duration (target under **180s**
  slowest shard, **20m** rule unchanged).

## Verification

- `packages/ci/test/fleet-capacity-input.test.ts`
- `scripts/test/main-workspace-shard-capacity.test.ts`
- `scripts/test/main-gate-plan-install-free.test.ts`
- `packages/ci-gh-actions/test/fleet-capacity.test.ts`
