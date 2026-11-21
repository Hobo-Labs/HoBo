---
type: CI Performance Finding
title: "Finding 155: merge queue vitest file shards and release integration lane"
description: "packages/hobo pins one vitest worker, so its whole suite was the merge queue's serial bottleneck and still ran whole in one shard; every matrix leg also saved the same Turbo cache key, and a step-level HOBO_TURBO_CONCURRENCY=1 pin overrode the memory-derived concurrency."
tags: [hobo, ci, performance, merge-queue, turbo, vitest, cache]
---

# Finding 155: merge queue vitest file shards and release integration lane

## Evidence

A one-worker run of `pnpm --filter @hobo/hobo test` on 2026-11-20 (the worker
count the package's own config pins, `capVitestWorkers(1)`, so the wall time is
the sum of its files):

| Suite | Serial seconds |
| --- | ---: |
| `test/vercel-project.test.ts` | 145 |
| `test/evals/ceremony-explorer.eval.test.ts` | 85 |
| `test/cd-runner-fleet-delivery.test.ts` | 35 |
| `test/cd-md-examples.test.ts` | 33 |
| whole suite (190 files, 2 490 tests) | 453 |

1. **Four suites held 298 of 453 serial seconds (66%).** Whichever workspace
   shard carried `packages/hobo` whole carried all of them at once.
2. **The duration table said 113 s.** `scripts/ci/workspace-test-durations.json`
   was measured before the suite grew; shard balancing planned for half the real
   weight.
3. **A whole suite cannot be split.** `shardTestPlan` partitions *packages*;
   a heavy package is one unit on one runner, however many shards the plan has.
4. **Every matrix leg saved the same cache key.** `github.job` is the job id,
   not the shard, so all `workspace_tests` / `main_workspace_tests` legs ran
   `actions/cache/save` on `turbo-<os>-<job>-…` concurrently, racing the
   reservation; `scripts-tests` already gated its save on `matrix.shard == 0`.
5. **A step-level `HOBO_TURBO_CONCURRENCY: "1"` overrode memory-env.** The
   workspace-tests step pinned one turbo task at a time even on runner classes
   where `memory-env` (ci-runner-preflight) had computed room for more.

## Change

- **Vitest file shards for heavy whole suites** (`scripts/ci/dependent-tests.mts`):
  a whole suite in `VITEST_SHARDABLE_PACKAGES` (packages/hobo to start) whose
  measured seconds are heavy is split into `vitest --shard=i/K` units —
  `ceil(seconds / 45)`, at most 4 — spread across workspace shards through the
  same `--only` pass-through the dependent subsets use. The slice count depends
  only on the plan, the duration table and the package's manifest (a plain
  `vitest run` test script), never on the shard count, so the planning job and
  every shard job expand identically. `planShardCount` never plans fewer shards
  than one sliced suite has file shards.
- **Slow suites moved to four hosted release shards**: the four suites above run
  only in `test:release-integration` (`vitest.release-integration.config.ts`,
  `test/support/release-integration-test-files.ts`). The unfiltered
  `release-hobo-pr.yml` runs four GitHub-hosted shards on pull requests and merge
  groups, with an 8-minute job ceiling and the `HoBo release integration PR gate`.
  Merge groups diff `github.event.merge_group.base_sha`; a missing base runs the
  lane, fetch or object-verification failure fails scope, and only a successfully
  computed out-of-scope diff skips install and tests successfully. Shard indexes
  use bash `$((SHARD_INDEX + 1))`, not a GitHub expression. The train's
  `release-hobo-integration` job still blocks `release-publish` and `release-npm`,
  but `HoBo release PR gate (required)` no longer needs it. Hosted PR shims in the
  train and Fabric exercise the lane before `release-hobo-pr.yml` reaches `main`;
  Fabric's shards are pull-request-only and are not a PR-impact-gate dependency.
  Every shard fetches the pinned ts-autocode before install, and only shard zero
  prunes or saves the L1 Turbo archive. The default suite remains measured at
  170 s and slices hobo into four workspace Vitest shards.
- **Turbo concurrency from memory-env**: the workspace-tests step-level
  `HOBO_TURBO_CONCURRENCY: "1"` pin is gone (main shards never had one); the
  cgroup-derived value `memory-env` writes during ci-runner-preflight applies.
- **One cache save per matrix**: `workspace_tests`, `main_workspace_tests`, and
  each release-integration matrix save only on `matrix.shard == 0`. The scripts
  matrix instead leaves its sole save to `scripts-tests-build`.

## Verification

- `scripts/test/dependent-tests.test.ts`: the vitest-file-shard describe (spread,
  manifest guard, subset exclusion, per-slice `--only` commands, shard-count
  floor) and the real-repo shard-coverage case now assert slice coverage.
- `packages/hobo/test/release-integration-lane.test.ts` pins the split: the four
  suites are excluded from both default projects and included, isolated, exactly
  once in the release lane.
- The release lane run on this tree: 4 files, 147 tests, 0 failures.
- Workflow pins: `release-integration-job.test.ts` (four hosted shards,
  unfiltered triggers, fail-closed merge-group scope, out-of-scope skips, gate
  results and bash shard math), `merge-group-gate.test.ts` (protected realize gate
  without an integration dependency), and `attested-jobs.test.ts` (plan synced;
  blob pins updated).

## Risks

- A shard flag changes the turbo task hash, so each slice caches separately;
  the build-once call is unchanged and keeps sharing hashes with plain
  `turbo run test`.
- `vitest --shard` with inline `projects` (the isolated/shared split) shards
  each project's files; the workspace planner retains `--passWithNoTests` for a
  slice that draws no file. The four-suite release lane deliberately does not
  use that flag.
- A broken release-integration suite now fails its merge-queue gate as well as
  publication. Hosted capacity and the 7-minute queue target require a
  production run observation; the workflow contract alone does not prove either.
