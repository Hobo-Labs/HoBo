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
- Shards 0 and 2 finished: their jobs took 15 min 16 s and 14 min 13 s, of which 15 and 13.6 minutes in `Workspace tests`, about 0.6 of the planner's estimate. Shards 1 and 3 ran closer to or past the estimate (at least 0.84 and 1.07 of it), so the plan's estimate is not a bound: runner speed varies (finding 116's contention on the box is one cause), and a shard planned near the limit is the one that misses it.

Main stayed red, and the next main run is repo-wide again for the same reason, so it would fail the same way. [Finding 116](0116-main-shard-timeout-cpu-admission.md) covers the CPU contention on the box during the same run. It places shard 1 on the shared box; the job's runner (`hobo-trunk-runner-vvss4`, runner group `default`) is an ARC pod.

## Cause

`planMainWorkspaceShardCount` never planned more shards than the fleet's parallel cap (four by default). Every shard job must stay under 20 minutes: the workflow caps every job there (#1754), and the box enforces it on its containers. A repo-wide plan is estimated at about 90 minutes of shard work (5491 s; at the 0.6 ratio seen above, about an hour), so four shards put each one at or past the limit, and any slow runner misses it.

## Fix

The planner still stays within the cap when the slowest shard fits `MAIN_WORKSPACE_SHARD_BUDGET_SECONDS` (12 minutes of estimated tests: the 19-minute `Workspace tests` step then tolerates a shard running up to about 1.6 times its estimate). When it does not fit, it adds shards past the cap until it does, up to `MAX_MAIN_WORKSPACE_SHARDS` (16), and stops early once another shard no longer lowers the slowest one (a single workspace over budget). The extra shards wait for a free runner instead of being cancelled. Run 43130657460's plan becomes eight shards with the slowest at 688 s. The shard time limits are unchanged.

A first version of this fix raised the shard time limits from the plan's estimate instead. Review stopped it: it broke the 20-minute job cap, and the box would still have stopped those shards at 25 minutes.

## Verified

- `scripts/test/main-workspace-shard-capacity.test.ts`: small plans stay within the cap; ten 5-minute suites at cap 2 plan exactly five shards (the previous planner returns two); a single workspace over budget stops the growth. The live repo-wide plan at cap 4 gives 8 shards with the slowest at 688 s.
- `scripts/test/dependent-tests.test.ts`: the repo-wide split puts every workspace in exactly one shard at 4, 8 and 16 shards.

## Not changed

- The plan job still reads `HOBO_CI_FLEET_CAPACITY` over the REST API, which a job's `GITHUB_TOKEN` cannot do (403), so the cap is four. Passing the variable through the `vars` context would make it live, but the published value counts the box's free slots only, without ARC, and the loader does not check its age, so the cap would only fall. That needs the published snapshot fixed first.
- `scripts/ci/route-runner.mts` parses a fleet-state document with `labels` and `publishedAt`; the relay publishes `{version, admittedParallel, hobo, arc, publishedAt}`, so the route job does not see capacity either.
- More shards repeat dependency builds on a cold turbo cache (each shard's `test` runs its `build` dependencies), and an affected push with 40 or more changed paths uses durations scaled ×2, so a near-repo-wide affected set can plan up to 16 shards. Shard time per shard falls less than in proportion.
- A repo-wide main run still costs about an hour of shard time; how much of it runs at once depends on the `hobo-trunk` ARC scale set's runner limit, configured in the cluster.
- New shard job names (shard 4 and up) have no learned memory or duration history on the box until they have run.
