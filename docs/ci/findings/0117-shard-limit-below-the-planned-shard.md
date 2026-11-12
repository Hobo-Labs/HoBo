---
type: CI Performance Finding
title: "Finding 117: shard limit below the planned shard"
description: "Main workspace shards had a fixed 19-minute step limit while the planner estimated a repo-wide run's slowest shard at 23 minutes; the limits now follow the plan."
tags: [hobo, ci, main-gate, shards, timeouts]
---

# Finding 117: shard limit below the planned shard

## Evidence

Main Fabric run [43130657460](https://github.com/Hobo-Labs/HoBo/actions/runs/43130657460) on `4c4db7036`, the first main run after [finding 113](0113-main-ci-starved-by-cancel-in-progress.md)'s fix, planned:

```text
load-fleet-capacity: variables/HOBO_CI_FLEET_CAPACITY returned 403
main gate plan: scope=repo-wide, tests=all, parallelCap=4, peakShardSeconds=1375, shards=[0, 1, 2, 3]
```

The last green main was `fb259629`, many commits back, and the lockfile had changed since, so the gate went repo-wide and every workspace test ran. The planner's own estimate for the slowest of four shards was 1375 s, about 23 minutes. The shard's `Workspace tests` step had a fixed 19-minute limit and the job a fixed 20. Shard 1, on an ARC pod (`hobo-trunk-runner-vvss4`), was cancelled after 19 min 9 s in that step; shard 3 hit the job limit. Main stayed red, and the next main run is repo-wide again for the same reason, so it would fail the same way.

[Finding 116](0116-main-shard-timeout-cpu-admission.md) covers the other half of this run: CPU contention on a shared box stretched shards that ran there. That does not explain shard 1, which ran alone on an ARC pod, and it does not change the plan: a 23-minute estimate cannot fit a 19-minute limit on an idle runner either.

## Cause

- The shard limits were constants, while shard length depends on the plan: an affected run is a few minutes a shard, a repo-wide run at a parallel cap of four is over twenty.
- The parallel cap fell back to its default of four because the plan job read `HOBO_CI_FLEET_CAPACITY` over the REST API, which a job's `GITHUB_TOKEN` cannot do (403).

## Fix

- `mainWorkspaceShardTimeouts` (`scripts/ci/dependent-tests.mts`) turns the plan's `peakShardSeconds` into a step limit of half again the estimate plus four minutes, never below the old 19 and never above 55, and a job limit six minutes longer. The plan job outputs both, and `main_workspace_tests` uses them, falling back to 19/20 when a plan has none. For run 43130657460's plan that is 39/45 minutes.
- The plan step passes `vars.HOBO_CI_FLEET_CAPACITY` as `HOBO_CI_FLEET_CAPACITY_JSON`, which `load-fleet-capacity.mts` already reads before trying the API.

## Verified

- `scripts/test/dependent-tests.test.ts`: an ordinary plan keeps 19/25, run 43130657460's plan gets 39/45, and the step never passes 55.
- `scripts/test/main-gate-workspace-shards.test.ts` pins the plan outputs, the vars wiring, and both limits on the shard job.

## Not changed

- When `HOBO_CI_FLEET_CAPACITY` is unset the cap is still four, and a repo-wide main run still takes most of an hour of shard time. Raising the `hobo-trunk` ARC scale set's runner limit (configured in the cluster, not this repo) is what would make those runs shorter.
