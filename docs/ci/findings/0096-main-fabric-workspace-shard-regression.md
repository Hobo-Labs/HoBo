---
type: CI Performance Finding
title: "Finding 96: main fabric workspace shard regression"
description: "Run 42982691062 took 12m54s when 42976976538 took ~4m; shard plan underestimated load after #1851."
tags: [hobo, ci, main-gate, turbo, sharding]
---

# Finding 96: main fabric workspace shard regression

## Evidence

| Run | SHA | Wall | Shard 0 | Shard 1 | Plan |
|-----|-----|------|---------|---------|------|
| [42976976538](https://github.com/Hobo-Labs/HoBo/actions/runs/42976976538) | `516b96b2` (#1865) | ~3m59s | 100s | 127s | `peakShardSeconds=125`, 2 shards |
| [42982691062](https://github.com/Hobo-Labs/HoBo/actions/runs/42982691062) | `47a0f193` (#1851) | ~12m54s | 616s | 462s | `peakShardSeconds=152`, 2 shards |

Both used `tests=affected` against last-green main (`TURBO_SCM_BASE`). The slow push diffed **135 paths** across three merges (`#1859`, `#1866`, `#1851`) versus **31 paths** on the fast push.

Shard 0 on the slow run had `HOBO_TEST_MAX_WORKERS=2` and a 6144 MiB cgroup on `hobo-trunk-runner-ttvvj`; the fast shard 0 had 15982 MiB and four workers — routing/hardware amplified cold-cache misses.

The route job sparse checkout omitted `packages/ci/src/fleet/capacity.ts` (added with #1859), so `route-runner.mts` logged `ERR_MODULE_NOT_FOUND` on GitHub-hosted route steps.

## Cause

1. **Affected set widened** — not a broken last-green base; #1851 added large `packages/ci-vercel` and `packages/hobo` suites to the scoped plan.
2. **Shard planner trusted stale per-package seconds** — `packages/ci-vercel` was weighted at 17s while new tests are closer to ~50s; duration table + 2-shard balance assumed ~152s peak.
3. **Too few shards for many whole suites** — five whole packages plus subsets fit the 180s target on paper but not on cold turbo with low parallelism.
4. **Route sparse checkout drift** — fleet capacity module not materialized for the route job.

## Fix

1. `minimumScopedShardCount` — at least `ceil(units/2)` shards (cap-limited) when more than three workspaces are in scope.
2. Cold-cache duration scaling when `git diff` path count ≥ 40 on affected main pushes.
3. Refresh `packages/ci-vercel` weight in `workspace-test-durations.json`.
4. Add `packages/ci/src/fleet/capacity.ts` to the route job sparse checkout.

## Verification

- `scripts/test/main-workspace-shard-capacity.test.ts`
- `node --experimental-strip-types scripts/ci/plan-main-workspace-shards.mts` against a synthetic 135-path diff (local)
