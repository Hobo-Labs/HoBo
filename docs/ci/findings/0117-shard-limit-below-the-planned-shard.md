---
type: CI Performance Finding
title: "Finding 117: shard limit below the planned shard"
description: "A repo-wide main run planned four shards whose slowest was estimated at 23 minutes, past the 19/20-minute shard limits; the planner now adds shards past the parallel cap until the slowest fits."
tags: [hobo, ci, main-gate, shards, timeouts]
---

# Finding 117: shard limit below the planned shard

## Evidence

Main Fabric run [43130657460](https://github.com/Hobo-Labs/HoBo/actions/runs/43130657460) on `4c4db7036`, the first main run after [finding 113](0113-main-ci-starved-by-cancel-in-progress.md)'s fix, planned:

```text
load-fleet-capacity: variables/HOBO_CI_FLEET_CAPACITY returned 403
main gate plan: scope=repo-wide, tests=all, parallelCap=4, peakShardSeconds=1375, shards=[0, 1, 2, 3]
```

The last green main was `fb259629`, many commits back, and the lockfile had changed since, so the gate went repo-wide and every workspace test ran. The planner's own estimate for the slowest of four shards was 1375 s, about 23 minutes. A shard's `Workspace tests` step stops at 19 minutes and its job at 20.

- Shard 1 ran on an ARC pod (`hobo-trunk-runner-vvss4`) and was cancelled after 19 min 9 s in `Workspace tests`.
- Shard 3 ran on a fleet box (`hobo-9277ba53…`) and ended 25 minutes after it started, mid-step: the box stops an isolated container at 20 minutes plus 5 of grace (`packages/ci-gh-actions/src/isolated-worker/container-timeout.ts`, `lease-reconciler.ts`).
- Shards 0 and 2 finished in 15 and 14 minutes.

Main stayed red, and the next main run is repo-wide again for the same reason, so it would fail the same way. [Finding 116](0116-main-shard-timeout-cpu-admission.md) covers the CPU contention on the box during the same run. It places shard 1 on the shared box; the job's runner (`hobo-trunk-runner-vvss4`, runner group `default`) is an ARC pod.

## Cause

`planMainWorkspaceShardCount` never planned more shards than the fleet's parallel cap (four by default). Every shard job must stay under 20 minutes: the workflow caps every job there (#1754), and the box enforces it on its containers. A repo-wide plan has about 90 minutes of shard work, so four shards cannot fit both rules.

## Fix

The planner still stays within the cap when the slowest shard fits `MAIN_WORKSPACE_SHARD_BUDGET_SECONDS` (12 minutes, which leaves room in the 19-minute step for setup and an estimate that runs short). When it does not fit, it adds shards past the cap until it does, up to `MAX_MAIN_WORKSPACE_SHARDS` (16). The extra shards wait for a free runner instead of being cancelled. Run 43130657460's plan becomes eight shards with the slowest at 688 s. The shard time limits are unchanged.

A first version of this fix raised the shard time limits from the plan's estimate instead. Review stopped it: it broke the 20-minute job cap, and the box would still have stopped those shards at 25 minutes.

## Verified

- `scripts/test/main-workspace-shard-capacity.test.ts`: a repo-wide plan at cap 4 plans more than four shards with the slowest under budget (fails against the previous planner, which returns four), and a plan goes over the cap only as far as the slowest shard needs.

## Not changed

- The plan job still reads `HOBO_CI_FLEET_CAPACITY` over the REST API, which a job's `GITHUB_TOKEN` cannot do (403), so the cap is four. Passing the variable through the `vars` context would make it live, but the published value counts the box's free slots only, without ARC, and the loader does not check its age, so the cap would only fall. That needs the published snapshot fixed first.
- `scripts/ci/route-runner.mts` parses a fleet-state document with `labels` and `publishedAt`; the relay publishes `{version, admittedParallel, hobo, arc, publishedAt}`, so the route job does not see capacity either.
- A repo-wide main run still costs about 90 minutes of shard time; how much of it runs at once depends on the `hobo-trunk` ARC scale set's runner limit, configured in the cluster.
