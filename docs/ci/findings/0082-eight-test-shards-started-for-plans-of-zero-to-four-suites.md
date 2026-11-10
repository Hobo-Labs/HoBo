---
type: CI Performance Finding
title: "Finding 82: eight test shards started for plans of zero to four suites"
description: "Every PR and merge group started eight workspace test jobs whatever the plan held; the matrix now follows the plan."
tags: [hobo, ci, performance, planner, shards, capacity]
---

# Finding 82: eight test shards started for plans of zero to four suites

## Symptom

PR run [42700351496](https://github.com/Hobo-Labs/HoBo/actions/runs/42700351496)
finished green. Its eight `Workspace test shard` jobs each spent 2 to 6 s in
the **Workspace tests** step. Six of them took about 25 s in all (checkout,
deps layer, install); shards 1 and 3 took 352 s and 391 s because checkout
and the cache restore stalled on a busy host.

PR run [42692342678](https://github.com/Hobo-Labs/HoBo/actions/runs/42692342678)
had work in three shards (152 s, 78 s, 36 s) and 2 to 7 s in the other five.
Its shards waited between 8 and 20 minutes for a runner.

Replaying the planner over the last 20 merges to `main`: 8 planned no suite at
all, 5 more planned four or fewer, and one planned more than 32. All 20 started
eight shard jobs on the pull request and eight more in the merge queue.

## Cause

`workspace_tests` had a fixed matrix, `shard: [0, 1, 2, 3, 4, 5, 6, 7]`. The
planner already knew how little there was to run, but only inside each shard,
after the job had taken a runner. A PR run is 18 jobs; eight of them were this
matrix. On a box with few slots the empty shards queue ahead of other PRs'
real work, and each one is another chance to stall in setup.

## Fix

`dependent-tests.mts --plan-shards=8` prints the shard list a plan needs: one
shard per four suites or subsets, at least one, eight for a repo-wide plan.
`PR impact validation` runs it and hands the list to the matrix.

- **No plan keeps all eight.** A repo-wide scope, a missing base, a planner
  failure or an answer that is not a list of shard numbers leaves the default.
- **The split cannot drop a suite.** Each job partitions by its own position
  in the matrix GitHub built (`strategy.job-index` of `strategy.job-total`),
  not by a count the planner reported, so a list and a count cannot disagree.
- **The gate is unchanged.** `PR impact gate` still requires the matrix result
  to be `success`. An empty plan runs one shard, so the result is never
  `skipped`.

Four per shard: shards run suites one at a time under a 19-minute step limit,
and the longest suite (`@hobo/hobo`) takes about three minutes cold.

## Result

Shard jobs for the last 20 merges, per event:

| | Before | After |
|---|---|---|
| Shard jobs | 160 | 37 |
| Merges that start one shard | 0 | 13 |
| Merges that start all eight | 20 | 1 |

Not measured on the box yet: per-shard wall time for the plans that now share
a shard. The first runs after this lands are the measurement.

## Residual

A plan with no suite still starts one job that installs and runs nothing.
Skipping it needs the gate to accept a `skipped` matrix, which it refuses on
purpose.

A changed package still runs its whole suite when only a test or a README in
it changed. Narrowing that was tried and dropped: tests read sibling files by
names the import walk cannot follow (`readPackageFile("README.md")` in
`packages/cloud-providers/test/parity.test.ts`), so a narrowed plan could pass
without running the test that reads the change.

## Verification

`scripts/test/dependent-tests.test.ts` (`planShardCount`) covers the count and
that the shards it asks for cover the plan. `scripts/test/merge-group-gate.test.ts`
pins the fallback, the pattern check, and the split by job position.
