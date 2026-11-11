---
type: CI Performance Finding
title: "Finding 92: main plan parallel deps affected shards"
description: "Main workspace plan no longer waits on ci-deps-image; shards still do. Turbo-affected shard planning shares cache with shards against last-green main."
tags: [hobo, ci, performance, main-gate, sharding, turbo]
---

# Finding 92: main plan parallel deps affected shards

## Evidence

Run [42951579615](https://github.com/Hobo-Labs/HoBo/actions/runs/42951579615) and the follow-up on `10dbc19fc` (`#1863`) kept **main workspace test** shards near **2m19s** and **2m24s**, but the workflow wall stayed **~4m14s** because **CI deps layer** (~20s) and **Main workspace plan** (~18s) ran serially before any shard could start, plus **~38s** of queue/plan overhead ahead of the parallel shard phase.

## Symptom

`main-gate-plan` listed `ci-deps-image` in `needs` even though planning is install-free (`scripts/test/main-gate-plan-install-free.test.ts`) and only needs the checkout plus optional deps-layer link for `turbo run test --affected --dry=json`. Shards already waited for both jobs, so serializing plan behind deps added the deps job duration to the shard start time without improving correctness.

## Change

- `main-gate-plan` — `needs: [route, ci-runner-image]` only; link deps layer, restore Turbo cache, install only on a layer miss, then `plan-main-workspace-shards.mts`; save Turbo cache for shard `preferred-job: main-gate-plan`.
- `plan-main-workspace-shards.mts` — sets `TURBO_SCM_BASE` while intersecting import-walk subsets (test-file scope) with `turbo --affected` before fleet-capped balancing (`MAIN_SHARD_TARGET_SECONDS=180`, `HOBO_CI_FLEET_CAPACITY` cap unchanged).
- `main_workspace_tests` — unchanged: still waits for `ci-deps-image`, uses `TURBO_SCM_BASE` + `HOBO_TURBO_USE_AFFECTED` from plan outputs, **4096 MiB** floor via `ci-runner-preflight`, **20-minute** job cap.

## Expected wall clock (typical affected doc-only push)

| Phase | Before | After (expected) |
| --- | --- | --- |
| Shard start delay (deps + plan) | ~38s serial | ~max(20s deps, ~25s plan) parallel |
| Slowest workspace shard | ~2m20s | ~2m20s (cache + affected unchanged) |
| S0 + finish (parallel with shards) | ~1m15s critical overlap | same |
| **Workflow billable wall** | **~4m14s** on `10dbc19fc` | **~2m45s–2m55s** when shards replay Turbo against last-green main |

Several consecutive green runs under **3 minutes** are the acceptance bar; measure with `ci-trace` on `Main workspace test shard *` and compare run wall time on Fabric pushes that stay `tests=affected`.

## Proof

- `scripts/test/ci-deps-image-contract.test.ts` — only `main_workspace_tests` waits on `ci-deps-image`; `main-gate-plan` does not.
- `scripts/test/main-gate-workspace-shards.test.ts`
- `scripts/test/main-workspace-affected.test.ts`
