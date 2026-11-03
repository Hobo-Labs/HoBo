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
- After the box daemon was restarted on main `96b9b70e` (2 slots × 6 GiB, peak 11.6 of 15 GiB): the
  `workflow_dispatch` run 41519610143 (1058 s) and the PR runs of #1639–#1645 on 2026-11-02 20:50–21:35 UTC.

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

Fixes: [#1641](https://github.com/Hobo-Labs/HoBo/pull/1641) (`docker create --init`). Needs a box redeploy;
the restart on `96b9b70e` predates it.

Since the restart the box runs two slots in parallel, and queueing for them is the largest share of wall
time. Between 21:02 and 21:35 UTC six runs (#1638's merge group and five PR runs) were queued at once, about
forty jobs for two slots. #1642's PR impact gate waited 17 minutes for a slot and then ran in 41 s; its
off-path job ran in 100 s. Fewer jobs per run is now worth more than faster jobs.

**The wait does not count against `timeout-minutes`.** GitHub starts a job's timeout when a runner picks it
up. Over 98 jobs the gap between `started_at` and the first step was at most 4 s, and in the last 40 runs no
`artifact signing and install verification` job timed out: the longest waited 18 minutes before `started_at`
(run 41523529717) and then passed in 39 s. A job that ends at its timeout was alive on a runner for that
long, which is finding 6, not a slot wait.

## Finding 2: Main full gate holds a slot for 4–10 minutes and always fails

Main full gate is not a required check, but it ran on every `merge_group` and `push` and occupied one of
the two slots for 244 s (median) to 600 s. Required jobs of the same run, and every PR run, queue behind it.
On `merge_group` it gated nothing (the queue waits only for required checks), and the push to main then
re-ran the same tree.

Fixes: [#1645](https://github.com/Hobo-Labs/HoBo/pull/1645) runs it on push, schedule and dispatch only.
If it is ever made a required check, `merge_group` has to come back first.

The rest of a merge group still asked for three slots. On 2026-11-03 at about 01:06 UTC the queue held six PRs
and built up to five groups at once (`max_entries_to_build: 5`), and their `hobo` jobs sat queued for about 17 minutes. Each
group ran Secret scan, CI runner image and the CI fabric contract guard, plus Main full gate until #1645:
four jobs per group and about 20 for five groups. Two of the three remaining jobs repeat work the PR run
already did:

- **Secret scan** scanned the full history on `merge_group`. The PR run had already scanned
  `base.sha..head`, the squashed group commit adds no lines beyond those commits, and the push to main
  scans the full history again.
- **CI runner image** checked `HEAD~1..HEAD` on a depth-1 clone and piped the diff to `rg`, which the
  worker image does not ship. Under `set -o pipefail` the detect step printed `needed=false` for every event
  except `workflow_dispatch` (run 41556540461 logs `rg: command not found`), so the job only held a slot.
  If detection worked, building on a group commit would also retag the box's `hobo-ci-worker:local` from
  an unmerged tree.

Both now skip on `merge_group`. A skipped job reports its check name as skipped, which the ruleset counts
as passing, the same way `PR impact gate` already behaves in the queue. The CI fabric contract guard keeps
running, because a group can combine two PRs that each passed it alone. With #1645 a group needs **one**
`hobo` job (about 40 s), so five groups fit in three waves on two slots. Detection in the runner image job now
works on `pull_request` and `push`: `grep` instead of `rg`, and `HEAD~1` on a depth-2 checkout. Only a change
to the image inputs builds, and `:local` moves only after the runner contract passes in the candidate.

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

**Update 2026-11-03: there was no `test:unit` death.** `gh run view --log` and the web log viewer drop the
tail of these steps, so the log seemed to stop inside Vitest. The raw job log
(`gh api --allow-escape-sequences repos/Hobo-Labs/HoBo/actions/jobs/<id>/logs`) shows otherwise for
main runs 41566469733, 41569957464, 41571861478 and 41571888563:

- `test:unit` passed (758 files, Vitest Duration 160–193 s).
- `test:behavior` then failed one of 102 scenarios: `features/examples-console-cloudflare-station.feature`.
  Its steps boot `astro dev` and wait 120 s for `http://127.0.0.1:4321/HoBo/api/cf-temp`. `astro dev` binds
  `localhost`, which resolves to `::1` first, so the probe never connected. Behind that, the scenario
  needs chromium and a live Cloudflare Temporary Accounts station (the script refuses a mocked
  workers.dev URL).

That is a live E2E inside the offline behavior lane, which `cucumber.yaml` and the repo testing policy rule
out. It now runs only under cucumber's `live` profile. Its steps bind `astro dev` to the probed host, wait
at most 60 s for it, and kill a Playwright run after 270 s. Without it, `test:behavior` passes 101/101 in
about 3 s (it was 123 s and red). With the step's tail missing, the passing `test:unit` read as a hang.
Reproduced off the box with the gate's own commands: `pnpm run test:unit` passed 758/758 in 146 s wall
(144 s reported, so nothing held the process open), and `test:behavior` on a751e0a95's config failed the
same scenario after 124 s.

The PR impact gate selects `test:behavior` when a feature, step, or `cucumber.yaml` changes, but it builds
only the changed packages, so the proofs' steps failed on `@hobo/code`'s missing `dist`. The relevant-check
policy now runs a serial `turbo run build --filter={./src/draft/epic-proofs/*}^...
--filter={./src/draft/projects/*}^...` (32 tasks, cached) first.

The rest of this section is the analysis as it stood before the raw logs were read.

The `test:unit` death has the same shape on all three main runs inspected. The step fails 380–395 s after it
starts, Vitest output stops about 55 s in, and no `Process completed with exit code` line is printed. The
non-TTY Vitest reporter prints nothing per file, so the log cannot distinguish an early kill with orphaned
fork workers still holding stdout from a late kill of a run that was still progressing. Locally the same
758 files pass in 149 s (four forks, ~3.1 GB peak RSS). Nothing in the `test:unit` file set signals its
process group or parent. The signal logging in #1638 is needed to name the sender. The death recurred after
the restart (dispatch run 41519610143: Main full gate failed after 7 minutes); #1638's own merge-group run
41527261479 is the first that will print the signal.

## Finding 3: the turbo cache never saved on main

`.github/actions/turbo-cache` used the combined `actions/cache`, which saves only in its post step and only
when the job succeeds. Main full gate always failed, so main never saved; every run logged `Cache not
found` and rebuilt everything. No `TURBO_TOKEN` is configured, so there is no remote cache either.

Fixes: [#1642](https://github.com/Hobo-Labs/HoBo/pull/1642) restores at job start and saves in an
`if: always()` step, pruned to the hashes the job's run summaries touched. Turbo caches only successful
tasks, so a partial save is correct. Pushes to main seed it; PRs and merge groups restore it. Test results
reach it only after finding 2's `test:unit` death is fixed and "Full workspace tests" runs.

Main's workspace tests are now scoped with `--filter=...[<previous main commit>]` (changed packages plus
their dependents). A git-based filter sees only files git attributes to a package, so
`scripts/ci/affected-lanes.mts` decides first: a workspace-wide input (lockfile, workspace, turbo,
tsconfig, biome, toolchain pins) or an unreachable base runs the whole workspace instead. The PR impact
gate uses the same script.

Where a test task does run, `@hobo/hobo#test` dominates. In an affected sweep for a four-package change it
took 181 s of 332 s task time (87 tasks).

## Finding 4: the pnpm store cache costs more than it saves on the box

- On a PR, restoring the 1.26 GB store archive takes 31 s and the install after it 16 s.
- A cold registry install of the same lockfile (1997 packages) takes 21 s.
- On main the seed save takes 71–146 s and then fails to reserve the cache key.
- Before the restart the box's pnpm store resolved to `/home/runner/.local/share/pnpm/store/v10`: the
  daemon was not yet passing the shared host store from #1635 (`HOBO_CI_PNPM_STORE_MOUNTED`). GitHub's
  `env` context does not include the runner's process environment either, so the action's
  `env.HOBO_CI_PNPM_STORE_MOUNTED` test could never see it.

Fixes: [#1639](https://github.com/Hobo-Labs/HoBo/pull/1639) detects the mount in a shell step and skips the
GitHub cache on self-hosted runners (restore and save). Verified on the restarted box: "pnpm store is
host-mounted (/pnpm-store)", "reused 1997, downloaded 0", install 21–22 s with no archive restore.

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
its run, which then needs a rerun.

It is not only #1637's bug. Lost runners continued after the restart on `96b9b70e`, which includes #1637:

- Dispatch run 41519610143, CI fabric contract guard (`hobo-a742da4d`): `pnpm install` started at 20:31:46
  and never finished. The job's 10-minute timeout could not be delivered, and GitHub cancelled it at 15
  minutes (timeout plus the 5-minute grace for an unresponsive runner). That one job is most of the run's
  1058 s wall time.
- #1640's run, CI fabric contract guard (`hobo-24695a3f`, 20:59–21:09): hung in `pnpm install` as well.

Both stopped in `pnpm install` against the host-mounted store, and in both the runner stopped talking to
GitHub rather than the step failing. A hung `pnpm` alone would still let the runner enforce the timeout and
upload logs, so the container, or every process in it, stopped. Box-side evidence is needed to tell a kill
from a stall: `docker events` and `docker inspect` (`State.OOMKilled`, exit code) for those two runner
names, the daemon log for their leases, the container cgroup's `memory.events` (a container stalled
reclaiming at its 6 GiB cap stops without being OOM-killed), and `dmesg` on the host. Whether the restart
itself happened during 20:31–20:46 also matters for the first case.

## Finding 7: things that are not the bottleneck

- **Checkout** is ~6 s per job (full clone; blobless was slower).
- **Hermetic mise image**: `ci-runner-image` rebuilds only when `mise.toml`/`mise.lock` or the image inputs
  change and pushes the result to GHCR. Otherwise it is a 10–17 s job, mostly checkout. When it does
  rebuild, it failed in 11 s on run 41519610143: Debian's `docker manifest inspect` rejects the pinned
  `debian:bookworm-slim` digest ("unsupported manifest media type
  application/vnd.oci.image.manifest.v1+json"), because that digest is an OCI index carrying attestation
  manifests. [#1644](https://github.com/Hobo-Labs/HoBo/pull/1644) checks the digest against the registry
  API instead. The in-container build then stopped after 6 s on the missing `skopeo`. Behind that,
  `127.0.0.1:5000` inside a job container is the container's own loopback, not the box's registry, and
  the contract check bind-mounted a checkout path the host does not have. `build.sh` now loads the layout
  with `docker load` when skopeo is absent (Docker Engine API ≥ 1.44). It reaches the registry by its
  bridge address from inside a container, and streams the contract inputs into the candidate image.
  `:local` moves only after that contract passes. `skopeo` is also in `system-packages.txt` for the next
  image.
- **wizer** (componentize-js) is bounded by `HOBO_RELEVANT_CHECK_CONCURRENCY=1` since #1636.
- The non-test parts of `check:all` take ~23 s locally (`test:schema` 10.7 s, `lint:test-deps` 7 s).
- `test:behavior` takes ~120 s locally, most of it one scenario waiting 120 s for `astro dev`.

## Finding 8: each job hands its slot over 37 s late, and main pushes pile up

Sample: every `hobo` job of the 31 HoBo CI Fabric runs created 2026-11-02 22:00 to 2026-11-03 01:56 UTC
(13 `merge_group`, 11 `pull_request`, 7 `push`), from the GitHub jobs API. Merge-queue entries waited
27–40 minutes, while the jobs they needed run 8–40 s.

**Where the slot-minutes went.** Main full gate on `merge_group` used 60.8 of about 150 job-minutes: nine
runs, every one failing or cancelled, gating nothing, because it is not a required check. Secret scan and
CI runner image waited 25–29 minutes on average in merge groups, for 8–12 s of work each. #1645 and #1647
take those three jobs off `merge_group`, leaving the CI fabric contract guard as each group's only `hobo`
job.

**Handoff, not slot count.** After the SQLite daemon came up (00:30 onward), the gap from one job's
`completed_at` to the next job's `started_at` was 31–45 s (median about 37 s) whenever work was queued.
For long stretches the box ran one short job at a time while 20 or more were queued. For example, between
01:11 and 01:18 no Main full gate was running, yet jobs started at 01:12:25, 01:13:42, 01:14:10 and
01:14:31, each a few seconds long. Since 00:30, a slot was empty while jobs were queued for about 40
slot-minutes. Two causes, both in the box daemon:

- `docker stop -t 30` on a job container whose PID 1 was `sleep infinity`. Without an init process, PID 1
  ignores SIGTERM, so every reap waited the full 30 s, and the lease counted as a live slot throughout.
  [#1641](https://github.com/Hobo-Labs/HoBo/pull/1641) (`--init`) fixes this once the daemon restarts on it.
- The daemon learned that a job was done only from GitHub. The poller (every `HOBO_CI_JOB_POLL_MS`, 15 s)
  had to report the runner's job first, then a tick's `getJob` had to see it completed. The JIT runner
  exits after its one job, so `startRunner` now writes `/tmp/hobo-ci-runner-exited` when `run.sh` returns,
  and reconcile reaps the container on the next 2 s tick when the marker is there. A runner that dies
  before taking a job is reaped the same way, and its reserved job is requeued. Before this it held the
  slot until the lease's maximum runtime.

**Main pushes.** The concurrency group never cancelled an in-progress push to main. Each squash merge
started a run whose Main full gate held a slot for about 7 minutes. Once two pushes landed close together,
both slots held a Main full gate and the queue's short jobs waited behind them. Two changes:

- The workflow group now includes the event name and cancels an in-progress push run. The newest push
  scans the full history and tests the newer tree.
- Main full gate also sits in a job-level group, so at most one runs at a time, whatever started it. The
  second slot stays free for short required jobs.

Schedule and `workflow_dispatch` runs are in their own groups and are never cancelled by a push.

**Expected.** One `hobo` job per merge group (about 40 s of run) plus a handoff of a few seconds, instead
of about 37 s. Five groups on the one slot Main full gate leaves free come to about 4 minutes. The box
daemon has to be restarted on a main that includes #1641 and this change before either handoff fix
applies.

## Before and after

Per-job medians (duration / wait for a slot) over the 43 runs before these changes. The after column comes
from the runs of PRs #1639–#1645 on 2026-11-02, each of which measures only its own change, on the box
restarted at `96b9b70e` (shared store live; #1641's `--init` not yet deployed).

| Job | Before: run | Before: wait | After (measured) | Change |
|---|---:|---:|---|---|
| CI runner image (mise oci) | 14 s | 210 s | 12–17 s; skipped on `merge_group` | #1640 drops the unused submodule checkout |
| Secret scan | 14 s | 209 s | 9–11 s; skipped on `merge_group` | #1640 drops the unused submodule checkout |
| CI fabric contract guard | 40 s | 225 s | 36–45 s | — |
| PR impact gate | 118 s (max 812 s) | 172 s | 41–43 s on small diffs | scales with the diff |
| PR off-path checks | 106 s | 155 s | 100–150 s; seconds on an inert diff | #1645 skips install and builds when no package, pin or submodule changed |
| artifact signing and install verification | 38 s | 310 s | 36–39 s, starts without waiting for `pr-gate` | #1640 |
| hobo dev cold loop | 61 s | 192 s | 50 s, starts without waiting for `pr-gate` | #1640 |
| Main full gate | 244 s (max 600 s), always failing | 150 s | not run on `merge_group` (#1645); seed-store save gone (#1639); build cached after one main push (#1642) | `test:unit` death open |

The waits are what keeps wall time above five minutes. They shrink when a slot is freed sooner (#1641),
when Main full gate holds its slot for less time or not at all (#1639, #1642, #1645), when PR jobs no
longer wait on each other (#1640), and when an inert job frees its slot in seconds (#1645).

## What is left to reach five minutes

Projection for a PR run alone on the box: about 390 job-s of work on two slots is ~200 s. Add four
handoffs at ~15 s each with `--init` (48 s today), and the run lands near **4 minutes**. Under a typical load
of two or three runs at once, queueing still pushes it past five. In order of expected gain:

1. **Find what stops lost runners** (finding 6). Each one holds a slot for 10–15 minutes and fails its run;
   one case alone made the 1058 s dispatch run. It needs the box-side evidence listed there.
2. **Redeploy the box daemon** again once #1641 lands, so `--init` takes effect (the restart on `96b9b70e`
   already brought the shared pnpm store and #1637).
3. **Main full gate green.** The "unit test death" was a live Cloudflare scenario failing in the offline
   behavior lane (finding 2). Main now tests only packages affected since the previous main commit
   (`turbo run test --filter=...[before]`), with the whole workspace on the weekly schedule or when a
   workspace-wide input changes. The job has a 20-minute limit, and `check:all` and the tests have step
   limits. `scripts/run-tests.ts` kills a Vitest run past `HOBO_TEST_RUN_TIMEOUT_MS` (default 600 s).
4. **Merge queue minimum wait.** The ruleset sets `min_entries_to_merge_wait_minutes: 5`, so a lone entry
   waits up to five minutes before its group is built. That alone is the whole budget; set it to 0–1. This is
   an admin setting, not a workflow change.
5. **More slots.** Two slots of 6 GiB on a 15 GiB host. Most jobs (secret scan, runner image, ci-guard,
   artifact trust) need well under 1 GiB, but GitHub assigns any `hobo` job to any runner, so slots cannot
   be sized per job. A third slot needs either a larger host or a lower per-slot cap backed by the memory
   data from #1636.
6. **Shard `@hobo/hobo#test`** (181 s, the longest test task) with `vitest --shard` once slots allow
   parallel shards. On two shared slots, sharding adds container overhead and slot contention for no gain.
7. ~~`test:behavior`'s astro scenario~~ moved to cucumber's `live` profile (finding 2).
8. **Fewer jobs per run is capped by the required checks.** Secret scan, CI runner image and the CI fabric
   contract guard each spend a container handoff on 10–40 s of work. Folding them into one job would cut
   two handoffs per run, but each is a required check by name, so that needs the ruleset changed with it.
   Not done here.

Risk to keep in mind: the box's pnpm store is a read-write host mount shared by every job, fork PRs
included (`forkPullRequestEnvironment: ci`). pnpm verifies tarball integrity against the lockfile on fetch,
but a job can still write into the shared store. The turbo cache deliberately stays on `actions/cache`
(scoped per ref) for this reason rather than becoming a shared host directory.
