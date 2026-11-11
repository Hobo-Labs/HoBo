---
type: CI Performance Finding
title: "Finding 93: main sub3m plan pickup shards"
description: "Install-free mise turbo planning, trunk prewarm on newest main Fabric push, route removed from main critical path, per-file shard loads within 10s."
tags: [hobo, ci, performance, main-gate, planning, shards]
---

# Finding 93: main sub3m plan pickup shards

## Evidence

After [#1865](https://github.com/Hobo-Labs/HoBo/pull/1865), run [42976976538](https://github.com/Hobo-Labs/HoBo/actions/runs/42976976538) on `516b96b2` improved main wall from **~4m14s** to **~3m59s** but missed the **&lt;3m** bar:

| Phase | Wall time |
| --- | --- |
| Queue before first pickup | ~28s |
| Route | ~6s |
| Main workspace plan (deps miss install) | ~52s |
| CI deps layer | ~13s |
| Workspace shards | ~1m40s + ~2m07s (**27s spread**) |
| Main full gate S0 (parallel) | ~2m23s |
| Finish | ~18s |

## Change

1. **Install-free plan** — `main-gate-plan` drops deps link, `pnpm install`, and Turbo restore/save; `HOBO_TURBO_INVOKER=mise` runs `turbo run test --affected --dry=json` via `scripts/ci/turbo-invoke.mts`. Optional `actions/cache` + `MAIN_GATE_PLAN_CACHE_DIR` keyed by tree SHA (target **&lt;15s** plan).
2. **Pickup** — Main trunk jobs (`main-gate-plan`, `main-gate`, `main_workspace_tests`, `main_gate_finish`) no longer `needs: route`; they queue on `hobo-trunk` immediately. The box daemon calls `prewarm` once per poll when a queued trunk job belongs to the newest main Fabric push (`newestMainFabricPushRunId`).
3. **Shard balance** — `planUnitLoadSeconds` prorates subset packages by selected test files; `planShardCountBalanced` adds shards until load spread ≤ `MAIN_WORKSPACE_SHARD_MAX_SPREAD_SECONDS` (10).

## Expected wall clock (typical affected push)

| Phase | Measured `516b96b2` | Expected |
| --- | --- | --- |
| Queue + route before trunk work | ~34s | **~10–15s** (no route gate; prewarm) |
| Plan | ~52s | **~10–15s** |
| Slowest shard | ~2m07s | **~1m55–2m00s** (±10s vs sibling) |
| Critical path | ~3m59s | **~2m35s–2m50s** |

Several consecutive greens under **3m** remain the acceptance bar.

**Local plan timing** (cloud agent, `HOBO_TURBO_INVOKER=mise`, warm `MAIN_GATE_PLAN_CACHE_DIR`): **~1.0s** for a repo-wide plan (4 shards).

## Proof

- `scripts/test/turbo-invoke.test.ts`
- `scripts/test/workspace-test-durations.test.ts`
- `scripts/test/main-gate-workspace-shards.test.ts`
- `packages/ci-gh-actions/test/superseded-main-push.test.ts`
