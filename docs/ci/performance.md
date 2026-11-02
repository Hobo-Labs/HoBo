---
type: CI Performance Analysis
title: "HoBo CI Fabric: where the wall time goes"
description: "Critical-path analysis of HoBo CI Fabric runs on the self-hosted hobo box, the fixes landed, and what is left to reach a five-minute run."
tags: [hobo, ci, performance]
---

# HoBo CI Fabric: where the wall time goes

Goal: PR, merge-queue and main runs of **HoBo CI Fabric** (`.github/workflows/hobo-ci.yml`) finish in under
five minutes of wall time. This note records what the data says, what has been changed, and what is still in
the way. Day-to-day tuning knobs live in [`../maintenance/ci-performance.md`](../maintenance/ci-performance.md);
the box worker runbook is [`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md).

## Data

- Per-job and per-step spans of runs before the parallel box worker (#1635), exported by the trace action.
- `gh run view` job/step timings of the 43 HoBo CI Fabric runs between #1635/#1637 and 2026-11-02 20:30 UTC
  (25 `pull_request`, 8 `merge_group`, 7 `push`, plus dispatches).
- Local reproductions on an aarch64 cloud VM (turbo summaries with `--summarize --force`).

Wall time is measured from run creation to the last job's completion. Work is the sum of job run times.

| Event | Runs | Wall median | Wall range | Work median |
|---|---:|---:|---:|---:|
| `pull_request` | 25 | 695 s | 33–1440 s | 494 job-s |
| `merge_group` | 8 | 489 s | 263–1055 s | 377 job-s |
| `push` (main) | 7 | 629 s | 263–814 s | 301 job-s |

## Finding 1: wall time is mostly waiting for a slot

Every job runs on the box worker, which holds **two** job containers at once (`HOBO_CI_WORKER_SLOTS=2` ×
`HOBO_CI_WORKER_MEMORY_MB=6144` on a 15 GiB host), and every run in the repository shares those two slots.

- **Median job wait is 189 s**; most jobs run for well under a minute.
- While at least one job was queued, the box ran **zero** jobs for 1101 s, one job for 1699 s, two for 1132 s.
  A slot sat idle with work waiting for most of that time.
- The gap between a slot freeing and the next queued job starting has a **median of 48 s** (p75 61 s,
  p90 82 s). A PR run (seven jobs on two slots) pays it about four times in series.

The idle gap has a concrete cause. Job containers run `sleep infinity` as PID 1, and PID 1 ignores
`SIGTERM`, so each `docker stop -t 30` that ends a finished lease waits the full 30 s for `SIGKILL`. The poll
tick reconciles leases serially, so that stop also delays launching the next job. Runner registration and
boot account for the rest.

Fixes: [#1641](https://github.com/Hobo-Labs/HoBo/pull/1641) (`docker create --init`). Needs a box redeploy.

## Finding 2: Main full gate holds a slot for 4–10 minutes and always fails

Main full gate is not a required check, but it runs on every `merge_group` and `push` and occupies one of
the two slots for 244 s (median) to 600 s. Required jobs of the same run, and every PR run, queue behind it.

Its steps on main (run 41517185031):

| Step | Time | Why |
|---|---:|---|
| pnpm install | ~21 s | cold registry install; fine |
| Seed the pnpm store cache for PRs | 71–146 s | tars a 1.26 GB store, then fails: "another job may be creating this cache" |
| check:all lint/guard lanes | ~33 s | |
| `pretest:unit` turbo build | ~50 s | 0/135 cached: the turbo cache never saved (finding 3) |
| `test:unit` (root + draft proofs, one fork) | ~295 s, then killed | ends with no Vitest summary and no exit-code line |
| Architecture guard (full repo) | — | duplicate of the step inside `check:all` |
| Full workspace tests (`turbo run test`, 789 tasks) | never reached | `check:all` failed first |

The `test:unit` death has the same shape on all three main runs inspected. The step fails 380–395 s after it
starts, Vitest output stops about 55 s in, and no `Process completed with exit code` line is printed. The
non-TTY Vitest reporter prints nothing per file, so the log cannot distinguish an early kill with orphaned
fork workers still holding stdout from a late kill of a run that was still progressing. Locally the same
758 files pass in 149 s (four forks, ~3.1 GB peak RSS). Nothing in the `test:unit` file set signals its
process group or parent. The signal logging in #1638 is needed to name the sender.

## Finding 3: the turbo cache never saved on main

`.github/actions/turbo-cache` used the combined `actions/cache`, which saves only in its post step and only
when the job succeeds. Main full gate always failed, so main never saved; every run logged `Cache not
found` and rebuilt everything. No `TURBO_TOKEN` is configured, so there is no remote cache either.

Fixes: [#1642](https://github.com/Hobo-Labs/HoBo/pull/1642) restores at job start and saves in an
`if: always()` step, pruned to the hashes the job's run summaries touched. Turbo caches only successful
tasks, so a partial save is correct. Pushes to main seed it; PRs and merge groups restore it. Test results
reach it only after finding 2's `test:unit` death is fixed and "Full workspace tests" runs.

A full `turbo run test` over a warm cache replays unchanged packages by content hash, so main does not need
git-based `--affected`. That would only see files git attributes to a package, while the turbo hash also
covers global inputs and environment. The PR impact gate
already filters by changed package through `scripts/ci/affected-lanes.mts`.

Where a test task does run, `@hobo/hobo#test` dominates. In an affected sweep for a four-package change it
took 181 s of 332 s task time (87 tasks).

## Finding 4: the pnpm store cache costs more than it saves on the box

- On a PR, restoring the 1.26 GB store archive takes 31 s and the install after it 16 s.
- A cold registry install of the same lockfile (1997 packages) takes 21 s.
- On main the seed save takes 71–146 s and then fails to reserve the cache key.
- The box's pnpm store resolves to `/home/runner/.local/share/pnpm/store/v10`, so the box daemon is not
  passing the shared host store from #1635 (`HOBO_CI_PNPM_STORE_MOUNTED`); it is still running older code.
  GitHub's `env` context does not include the runner's process environment either, so the action's
  `env.HOBO_CI_PNPM_STORE_MOUNTED` test could never see it.

Fixes: [#1639](https://github.com/Hobo-Labs/HoBo/pull/1639) detects the mount in a shell step and skips the
GitHub cache on self-hosted runners (restore and save).

A pre-baked store in the runner image was considered and not done. It saves at most ~15 s per install, goes
stale on every lockfile change, and adds the store to the image. The host-mounted store from #1635 gives the
same hard-link install once the box is redeployed.

## Finding 5: serial job dependencies

`artifact-trust` and `dev-cold-loop-gate` had `needs: pr-gate`, so they waited for the slowest PR job and then
for a slot. Neither consumes anything from `pr-gate`. `ci-runner-image` and `secret-scan` checked out the
ts-autocode submodule without using it.

Fixes: [#1640](https://github.com/Hobo-Labs/HoBo/pull/1640). On its own run, the cold loop finished before
the CI fabric contract guard had even started.

## Finding 6: lost runners cost ten minutes each

Ten jobs in the sample ran 590–900 s, against medians of 14–118 s. Five of them stopped mid-step: in
`pnpm install`, the pnpm-store step, or checkout, with steps left without a conclusion and no log uploaded.
Their own `timeout-minutes` (5 to 45) did not fire. GitHub failed them after about ten minutes without
contact from the runner, so the container or runner process died under a live job. That matches the bug
#1637 fixed: the daemon force-stopped live job containers when `docker inspect` timed out under load. The
box was still running older code (see finding 4). Each lost runner holds a slot for ten minutes and fails
its run, which then needs a rerun. One happened again on #1640's run
(CI fabric contract guard, hung in `pnpm install`).

## Finding 7: things that are not the bottleneck

- **Checkout** is ~6 s per job (full clone; blobless was slower).
- **Hermetic mise image**: `ci-runner-image` rebuilds only when `mise.toml`/`mise.lock` or the image inputs
  change and pushes the result to GHCR. Otherwise it is a 10–17 s job, mostly checkout.
- **wizer** (componentize-js) is bounded by `HOBO_RELEVANT_CHECK_CONCURRENCY=1` since #1636.
- The non-test parts of `check:all` take ~23 s locally (`test:schema` 10.7 s, `lint:test-deps` 7 s).
- `test:behavior` takes ~120 s locally, most of it one scenario waiting 120 s for `astro dev`.

## Before and after

Per-job medians (duration / wait for a slot) over the 43 runs before these changes. The after column comes
from the runs of PRs #1639–#1642 on 2026-11-02, each of which measures only its own change. The box
redeploy that #1641 needs has not happened yet.

| Job | Before: run | Before: wait | After (measured) | Change |
|---|---:|---:|---|---|
| CI runner image (mise oci) | 14 s | 210 s | 12–17 s | #1640 drops the unused submodule checkout |
| Secret scan | 14 s | 209 s | 9–11 s | #1640 drops the unused submodule checkout |
| CI fabric contract guard | 40 s | 225 s | 36–45 s | — |
| PR impact gate | 118 s (max 812 s) | 172 s | 41–43 s on small diffs | scales with the diff |
| PR off-path checks | 106 s | 155 s | 100–150 s | — |
| artifact signing and install verification | 38 s | 310 s | 36–39 s, starts without waiting for `pr-gate` | #1640 |
| hobo dev cold loop | 61 s | 192 s | 50 s, starts without waiting for `pr-gate` | #1640 |
| Main full gate | 244 s (max 600 s), always failing | 150 s | seed-store save gone (#1639), build cached after one main push (#1642) | `test:unit` death open |

The waits are what keeps wall time above five minutes. They shrink when a slot is freed sooner (#1641),
when Main full gate holds its slot for less time (#1639, #1642), and when PR jobs no longer wait on each
other (#1640).

## What is left to reach five minutes

Projection for a PR run alone on the box: about 390 job-s of work on two slots is ~200 s. Add four
handoffs at ~15 s each with `--init` (48 s today), and the run lands near **4 minutes**. Under a typical load
of two or three runs at once, queueing still pushes it past five. In order of expected gain:

1. **Redeploy the box daemon** so #1635's shared pnpm store, #1637's inspect-error fix (lost runners,
   finding 6) and #1641's `--init` take effect.
2. **Fix the `test:unit` death on main** (#1638 logs the signal). Until it is fixed, Main full gate burns a
   slot on every merge and push, and test results never reach the turbo cache.
3. **Merge queue minimum wait.** The ruleset sets `min_entries_to_merge_wait_minutes: 5`, so a lone entry
   waits up to five minutes before its group is built. That alone is the whole budget; set it to 0–1. This is
   an admin setting, not a workflow change.
4. **More slots.** Two slots of 6 GiB on a 15 GiB host. Most jobs (secret scan, runner image, ci-guard,
   artifact trust) need well under 1 GiB, but GitHub assigns any `hobo` job to any runner, so slots cannot
   be sized per job. A third slot needs either a larger host or a lower per-slot cap backed by the memory
   data from #1636.
5. **Shard `@hobo/hobo#test`** (181 s, the longest test task) with `vitest --shard` once slots allow
   parallel shards. On two shared slots, sharding adds container overhead and slot contention for no gain.
6. **`test:behavior`'s astro scenario** waits 120 s for `astro dev`; start it once per run or mock it.

Risk to keep in mind: the box's pnpm store is a read-write host mount shared by every job, fork PRs
included (`forkPullRequestEnvironment: ci`). pnpm verifies tarball integrity against the lockfile on fetch,
but a job can still write into the shared store. The turbo cache deliberately stays on `actions/cache`
(scoped per ref) for this reason rather than becoming a shared host directory.
