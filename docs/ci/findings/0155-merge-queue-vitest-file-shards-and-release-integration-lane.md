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
- **Slow suites moved to a release lane**: the four suites above now run only in
  `test:release-integration` (`vitest.release-integration.config.ts`,
  `test/support/release-integration-test-files.ts`), in release-hobo.yml's
  `release-hobo-integration` job, blocking `release-publish` and `release-npm`.
  A pull request pays for them only when its diff reaches the suites or the lane
  (the workflow's path filters plus a `job-scope` step); every release runs
  them. The job checks out with `submodules: "false"` like every job in this
  workflow, so it fetches the pinned ts-autocode itself (`pins:fetch
  ts-autocode`) before install, the same order `release-contract` uses —
  without it the install fails on the missing workspace members the lane's
  turbo graph builds. The default suite re-measured at 170 s wall; the table
  says 170 s (the fast merge-queue lane's measured weight, no startup padding),
  which slices hobo into 4 vitest shards.
- **Turbo concurrency from memory-env**: the workspace-tests step-level
  `HOBO_TURBO_CONCURRENCY: "1"` pin is gone (main shards never had one); the
  cgroup-derived value `memory-env` writes during ci-runner-preflight applies.
- **One cache save per matrix**: `workspace_tests` and `main_workspace_tests`
  save the Turbo cache only on `matrix.shard == 0`, like `scripts-tests`.

## Verification

- `scripts/test/dependent-tests.test.ts`: the vitest-file-shard describe (spread,
  manifest guard, subset exclusion, per-slice `--only` commands, shard-count
  floor) and the real-repo shard-coverage case now assert slice coverage.
- `packages/hobo/test/release-integration-lane.test.ts` pins the split: the four
  suites are excluded from both default projects and included, isolated, exactly
  once in the release lane.
- The release lane run on this tree: 4 files, 147 tests, 0 failures.
- Workflow pins: `merge-group-gate.test.ts` (no step-level concurrency pin,
  shard-0-only cache saves, the release gate's new job),
  `attested-jobs.test.ts` (plan synced; blob pins updated).

## Risks

- A shard flag changes the turbo task hash, so each slice caches separately;
  the build-once call is unchanged and keeps sharing hashes with plain
  `turbo run test`.
- `vitest --shard` with inline `projects` (the isolated/shared split) shards
  each project's files. The release-integration job pins four shards to four
  files and omits `--passWithNoTests`, so an empty glob fails the shard.
- The merge queue no longer fails on a broken release-integration suite at merge
  time; it fails at publish. That is the accepted trade: the release gate runs
  on every planned release and on every PR that touches the lane.
- Hosted run 44864749033 still paid 7m18s serial in this job because merge-queue
  checkouts have no `HEAD^2`, so the scope step always ran the lane. The job now
  diffs `merge_group.base_sha` and shards the four files on `ubuntu-24.04`.
- Hosted PR run 44867963592 never started `release-hobo`: GitHub's `paths`
  filter for that synchronize looked at the merge-from-main commit (attestation
  blobs only). GitHub evaluates the **default-branch** copy of `paths`, so
  globs added only in this PR cannot self-trigger until merge. The workflow
  file and `scripts/lib/release-hobo-path-filters.mts` are already on main's
  list, yet a later synchronize that edited both still skipped (run
  44870024997 is the tag-filtered `push` miss; no `pull_request` run). The
  lane files now sit at the **top** of both `pull_request.paths` and
  `merge_group.paths` (workflow, `scripts/test/release-integration*`, the
  job-scope script, and `scripts/test/release-freight.test.ts`, which is the
  file that starts sibling PR 2930). A branch push still mints a 0-job
  `push` miss (tags-only). That run used to share a concurrency group with
  `pull_request`, so the PR lane never started. The group now includes
  `github.event_name`. A forward commit that edits
  `scripts/test/release-relevant-push.test.ts` (also on main's filter)
  re-measures the four shards and `HoBo release PR gate`.
- `--passWithNoTests` is gone: four shards are pinned to the four suite files,
  so an empty glob fails the shard instead of greening a dead lane. Prune/save
  run only on shard 0. The job `needs: [route]` so it does not wait on the
  main-train gate (which skipped every step on that PR but still took a runner).
