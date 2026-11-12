---
type: CI Performance Finding
title: "Finding 105: per-job workdir inodes"
description: "A single box PR job peaked near 176k workdir inodes and pushed host inodes toward 89% at peak on 715206e33."
tags: [hobo, ci, performance, worker, storage, pnpm, git]
---

# Finding 105: per-job workdir inodes

## Evidence

Main push run [43017688406](https://github.com/Hobo-Labs/HoBo/actions/runs/43017688406) on `715206e33`: one PR-class job workdir measured about **176k inodes** at retire, host work-root inode use near **89%** with several concurrent jobs.

## Cause

Admission peaks counted total workdir entries, including a real **`node_modules/.pnpm`** tree when a fallback **`pnpm install`** ran beside the symlinked **`/opt/hobo-deps`** layer. Checkout **`.git`** objects dominate the remainder even with sparse cones.

## Fix

- **`hobo_ci_work_dir_inode_breakdown`** at job retire: `git`, `linkedNodeModules`, `pnpmVirtualStoreInWork`, `other`.
- **Storage peaks** use **`localInodes`** (total minus symlinked deps roots and in-work `.pnpm`) so admission learns job-local growth, not shared store or layer content.
- **`deps-layer.mts link`** collapses real **`packages/**/node_modules`** trees back to payload symlinks after a miss install.

**Regression:** `scripts/test/deps-layer.test.ts` asserts `collapsePackageNodeModules` leaves package `node_modules` as symlinks into the payload.

## Measure

On the next multi-shard main Fabric push: breakdown logs show falling **`pnpmVirtualStoreInWork`** when the layer hits; concurrent shard count rises before **`hobo_ci_inode_pressure`** without lowering `HOBO_CI_WORKER_WORKDIR_INODES` caps by hand.
