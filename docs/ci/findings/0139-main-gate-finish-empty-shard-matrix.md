---
type: CI Performance Finding
title: "Finding 139: main gate finish empty shard matrix"
description: "Run 43188550050 finish failed when main-gate-plan emitted PLAN_SHARDS=[] because an empty matrix reports failure instead of skipped."
tags: [hobo, ci, main-gate, matrix, shards]
---

# Finding 139: main gate finish empty shard matrix

## Evidence

Main run [43188550050](https://github.com/Hobo-Labs/HoBo/actions/runs/43188550050) after `09f1e8129`: **Main full gate (finish)** job `131084376894` failed with `Main workspace test shards did not all succeed: failure` while **Main workspace plan** succeeded with `PLAN_SHARDS=[]`.

## Cause

`main_workspace_tests` used `fromJSON(shards || '[0]')`. When the plan emitted `[]`, GitHub Actions built an empty matrix and reported the job as **failure**, not **skipped**. Finish required `WORKSPACE_RESULT == success`.

## Fix

- Skip `main_workspace_tests` when `needs.main-gate-plan.outputs.shards` is `[]` or empty (explicit plan output only).
- Finish waits on `main-gate-plan`, requires `PLAN_RESULT == success`, and passes when `PLAN_SHARDS` is empty (including the legacy empty-matrix `failure` case) before checking shard success.

## Verified

- `pnpm run test:smoke scripts/test/main-gate-workspace-shards.test.ts`
- `pnpm run test:smoke scripts/test/main-gate-finish.test.ts`
