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
the box worker runbook is [`packages/ci/RUNNER-QUEUE.md`](../../packages/ci/RUNNER-QUEUE.md). The plan for
prebuilt checkout and install layers is [`oci-layer-plan.md`](./oci-layer-plan.md).

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
| pnpm install | ~21 s | copies the store into the container; finding 19 |
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

**Vitest wall time ≈ 3x its Duration happened once, and it was the box.** In run 41566469733, Vitest's
own `Start at 02:33:20` and its summary line at 02:43:41 are 621 s apart, yet it reported `Duration
192.60s`. Vitest's default reporter sets both `Start at` and the duration start in `onTestRunStart` and
measures with `performance.now()`, so one process saw 192 s on the monotonic clock while 621 s passed on
the wall clock. CPU contention, pool settings, or a teardown hang cannot do that, since all three still
advance the monotonic clock. A suspended or paused host stops it. The job on the box's other slot
(artifact signing, run 41566513729) logged nothing for 599 s over the same window, stuck at
`Cloning into external/ts-autocode`, until it was cancelled. The three later main runs show no gap:
`Start at 03:06:01`, summary at 03:08:43, `Duration 161.90s` (41569957464), and likewise 176.5 s and
160.6 s. `scripts/run-tests.ts` now prints a line when the wall clock runs more than 30 s ahead of the
monotonic clock, so the next pause reads as one. It fired on the first main run after that landed
(41578806148): "the wall clock ran 484s ahead of the monotonic clock", with `Duration 233.52s` against
a 13-minute job. Vitest's `Start at 04:34:42` and summary at 04:46:40 are 718 s apart, which is 233.5 s
plus the 484 s gap. The workload did not stall. The whole box did: between 04:34:41 and 04:44:49 the
box started no job for any branch, although main's Secret scan had been queued since 04:33:21 and a
slot was free. A slow test file in one container cannot stop the other slot's runner from polling.
That is two pauses in five main runs, both during a repo-wide `test:unit`, so the box's host (sleep, VM
pause, or memory reclaim on the host) is the next thing to inspect.

Short stalls hit fixed-budget tests the same way. On 2026-11-03 two tests that take under a second
anywhere else timed out within an hour of each other. The first was `@hobo/ci-dagger`'s
process-group test, at 20 s in main run 41603401743. The second was
`scripts/test/ci-runner-image-contract.test.ts` "documents required commands", at 10 s in PR run
41607939139: its step normally takes 4–5 s and took 35 s there. Neither failure depended on what the
test checked. Both waited on host timing: one on file and `/proc` polls under fixed budgets, the
other on about 13 sequential tool spawns run just to read check names. The fix is the same in both
cases: wait on events, or do no process work at all. The process-group tests now synchronise over a
Unix socket the fixture holds until it dies. The contract tests that only read check names pass a
stub `run` to `evaluateCiRunnerContract`, while the preflight case still runs the real probes.

`test/hobo-home-isolation.test.ts` "stays set after a file's last test" failed the same way in #1664's
second attempt: it expected one late write and saw none. Its probe file `a` leaves a 0 ms timer, and
file `b` was meant to keep the worker alive with a 500 ms sleep. But vitest's default sequencer runs
larger files first, so `b` always ran before `a`. The write then landed only when the timer beat the
worker's shutdown. Delaying the timer to 200 ms fails that version every time. The probes now run in
name order, `a`'s timer resolves a promise the worker shares (`isolate: false`), and `b` waits for that
promise, so the test no longer depends on how fast the timer fires.

Reproduced off the box under its conditions: two concurrent `pnpm run test:unit` jobs, each with the
gate's environment (`CI=true`, `HOBO_RELEVANT_CHECK_CONCURRENCY=1`,
`NODE_OPTIONS=--max-old-space-size=3072`), on a 4-CPU, 15 GiB host like the box's. Both passed
758/758 in 152 s and 154 s of wall time, with `Duration` 148 s and 150 s, so nothing paused. Peak RSS was
2.58 and 2.51 GiB per job (process tree), against the 6 GiB container limit, and host
`MemAvailable` never dropped below 9.9 GiB. The 6 GiB cap could not be imposed there (no Docker,
no cgroup delegation), so it was checked against measured RSS rather than enforced. Three componentize
proofs take 90 s of the 150 s (wizer: 57, 16 and 16 s). `scripts/lib/vitest-progress-reporter.ts` now
prints a heartbeat naming the running files, marks host pauses where they happen, and lists the
slowest files at the end of every `run-tests` lane. The same run's one
failure was `hobo-wit-toolchain-contract`'s rerun test at the 10 s default. It runs the jco generator
three times, about 1.3 s locally, so its two generator tests now carry a 30 s timeout.

The next main run (41580946041, about 6 minutes) failed one Workspace test: `@hobo/ci-gh-actions`
`waits for TERM-ignoring descendants after parent timeout` got "runner process group shutdown could not
be confirmed" after 16.6 s. That was a product bug that a stall exposes, not a different message on the
box. `runHostProcess` sent `SIGKILL` 10 s after `SIGTERM` and gave up at 12 s, on two independent timers.
If the event loop does not turn for more than 2 s across the 10 s mark, which a CPU-starved or paused host
causes, both timers fire in the same turn. The group is killed and shutdown is declared unconfirmed before
any check can see it go. 16.6 s against a nominal 11 s fits a stall of about 3.5 s. Busy-waiting the event
loop for 4 s from 10.5 s reproduced the box message exactly on this VM. The confirmation window now starts when
`SIGKILL` is sent, and a last check runs before giving up. A `/proc` read that races a reaped process
(`ESRCH` as well as `ENOENT`) now counts as gone instead of as an unconfirmable shutdown. The 10 s grace and
2 s confirmation stay the production defaults. `runHostProcess` takes them as an optional
`HostShutdownTimings`, so the escalation tests use a 300 ms grace. A new test blocks the event loop across
the kill and fails with the old timers. `test/bootstrap.test.ts` went from 28 s on the box (21 s locally)
to about 5 s locally, and its longest case is the 2.9 s stall test instead of 16.6 s.

**Main full gate is affected-only.** Before this change, every main push ran `check:all` (repo-wide lint,
architecture guard, all 758 root unit files, behavior) whatever it touched. A step now resolves the
previous main commit (the push's `before`, or `HEAD~1` for a dispatch) and runs
`scripts/ci/affected-lanes.mts --main-gate` on the diff. Root config, the lockfile, toolchain pins
(`mise.toml`, `mise.lock`), a deleted package, or an empty diff get `check:all`. Everything
else gets `agent:check --base=<previous main>`, the same impact-scoped policy the PR impact gate runs.
`.github/` used to be on the repo-wide list too, and it is the one input CI-tuning PRs always touch: run
41592443075 (4m48s) spent 3m24s of it in `check:all` for a workflow edit that the PR and
merge-group runs had already executed. Workflow and action files are now affected-only; agent:check
still selects the automation lanes (`scripts/relevant-check-policy.ts`) for them.
Workspace tests use `turbo run test --filter=...[<previous main>]` unless an input turbo hashes into
every task changed. A workflow edit cannot change a package test's result, so it alone does not widen
them. The weekly schedule is the one whole-workspace sweep, with a 60-minute job limit; main pushes keep
20. `scripts/test/affected-lanes.test.ts` pins both rules and dry-runs turbo to show that a scoped
filter leaves an unrelated package (`@hobo/storage-sqlite`) out.

Generated-output drift is the exception to affected scoping on main pushes. The `Generated-output drift`
step always runs both `pnpm run codegen:check` and the frozen `s0-04-protobuf-cue-codegen` proof suite,
even when neither appears in the affected diff. This closes the gap exposed when #1693 started running
workspace tests on `merge_group`: #1597 had opted `@hobo/ci-vercel` into protobuf codegen while its relay
and sandbox asset generators also wrote into `src/_generated/`. Production codegen ignored those
non-protobuf files, but the frozen proof reported them as added drift. Their output now lives in
`packages/ci-vercel/src/_generated-assets/`, leaving `src/_generated/` exclusively to protobuf codegen.

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

Two follow-ups, measured on main. The prune kept only the entries the job's own runs touched, and main's
runs are affected-only, so each save shrank the cache to a handful of packages and the next run built the
rest cold: run 41587620284 (7m16s, green) spent about 60 s of its 4m56s "Workspace tests" on cold
builds. And run 41580946041's "Save Turbo cache" took 2m00s, all of it `Getting action download info`
for the composite's `actions/cache/save` timing out (100 s) and retrying; the save itself took a
second. `scripts/ci/turbo-cache-prune.mts` now keeps entries used within 7 days, and runs as a workflow
step that outputs `save=false` when no task missed the cache, so a fully cached run skips the save step
and never resolves the action.

Main's workspace tests are now scoped with `--filter=...[<previous main commit>]` (changed packages plus
their dependents). A git-based filter sees only files git attributes to a package, so
`scripts/ci/affected-lanes.mts` decides first: a workspace-wide input (workspace, turbo,
tsconfig, biome, toolchain pins) or an unreachable base runs the whole workspace instead; `pnpm-lock.yaml`
alone does too, but a lockfile edit together with changed package paths only runs those packages (Turbo
still hashes the lockfile). The PR impact gate uses the same script.

Where a test task does run, `@hobo/hobo#test` dominates. In an affected sweep for a four-package change it
took 181 s of 332 s task time (87 tasks).

**Dependents run only the test files that can see the change.** A package filter is still too coarse:
`@hobo/hobo` depends on `@hobo/ci-gh-actions`, so every worker-daemon or poller edit ran all ~200 s of
hobo's suite, though hobo imports only four of ci-gh-actions' entry points and none of them reaches the
worker. `scripts/ci/dependent-tests.mts` now plans main's Workspace tests: packages with a changed file
run whole through turbo, and each dependent runs only the test files whose import closure reaches a
changed file. The walk follows imports, `resolve()` calls and path literals file by file, crosses
packages through each manifest's `exports` (so `@hobo/ci-gh-actions/client` is `src/client.ts`, not the
package), and reads a `dist/` path as the `src/` file built into it, which is how hobo's tests reach
the CLI they spawn. A literal naming another package's file, such as `hobo ci serve --with-worker`
spawning the daemon, is that one file: the daemon runs as its own process and ci-gh-actions' suite
covers what it imports. It gives up, and runs the test, on a computed `import()` in a test or a relative
import it cannot resolve; a dependent whose `test` script is more than `vitest run`, or whose vitest
config reaches the change, runs whole. For a change to ci-gh-actions' `src/hosted-relay.ts`, hobo now
runs 1 of its 111 test files (`cloudflare-worker-routes`, through its computed import; `e2e/ci.test.ts`
imports the relay too but hobo's vitest config excludes `e2e/`) and `examples/self-host-yard` is
skipped; `src/isolated-worker/github-job-poller.ts` gives the same. `src/client.ts` still runs most of
hobo, because hobo's CLI entry imports it. `scripts/test/dependent-tests.test.ts` pins
the rules on an in-memory tree.

The first version ran each dependent's file subset as `turbo run build` and then `vitest run` in the
package, which bypassed turbo's `test` task. A package's `<pkg>#test` `dependsOn` lists builds its
tests need beyond its own dependencies: `@hobo/hobo#test` adds `@hobo/adapter-hono#build`, because
`examples/hello-bindle` imports it at test time. That build never ran on the main path, and main runs
41616466379 and 41618937951 failed 13 hobo tests with `Failed to resolve entry for package
"@hobo/adapter-hono"`. PR runs passed because the impact gate calls `turbo run test`.

The second version (#1664) ran each subset as `turbo run test --filter=./<dir> -- <files>`. Turbo
hands `--` arguments to every task of a run, dependency builds included, and hashes them in. Main run
41632724009 (754 s) therefore rebuilt about 80 packages uncached for each of six subsets: Workspace
tests took 8 minutes, `@hobo/code`'s subset 2m10s and `@hobo/hobo`'s 3m01s around 75 s of vitest.

Now the planner reads turbo's own graph (`turbo run test --filter=… --dry=json`) once and makes one
call with those task ids and no pass-through. That call runs the whole suites and every build the
subsets' test tasks depend on, the `<pkg>#test` overrides included, with the same hashes as a plain
`turbo run test`, so it shares the cache. Then each subset runs its test task alone:
`turbo run test --filter=./<dir> --only -- --passWithNoTests <files>`. Replaying #1664's diff locally
gives one 86-task build call and six subset calls, 120 s in all at `--concurrency=1`. The planner test
pins the command shape on a fake graph, and checks against the real graph that `@hobo/hobo`'s subset
gets `@hobo/adapter-hono#build` in the build call.

**hobo's own suite runs its process-bound cases concurrently.** Four files held 133 s of the suite's
177 s of test time, each case starting `hobo` or a composed binary and waiting on it:
`starter-deployment-end-to-end` (53.6 s), `persistent-local-deployment` (38.5 s), `bin-opensesame`
(24.6 s) and `composed-temp-dirs` (16.6 s). Their cases already used separate projects, `HOBO_HOME`s
and OS-assigned ports; the last two shared module-level directories set in `beforeEach`, now made per
test and removed with `onTestFinished`. All four are `describe.concurrent`, with the test context's
`expect`. Measured on a four-core VM with `CI=1` (two workers): the four files take 21 s, 15 s, 10 s
and 6 s alone, and the whole suite went from 145 s to 116–120 s wall, test time from 177 s to 117 s.
What remained was mostly import. hobo's config set `isolate: true` for every file, so each of 111
files composed the CLI again, about 105 s of worker time. In main run 41606568492 (204 s), that suite
took 123 s of the 142 s S0 step. Isolation only matters for a file that changes process-wide state.
Seven do: they set `process.env` or `globalThis.fetch` and restore it afterwards. None of the other
104 uses a mock, spy, fake timer, stubbed global or `process.on`. The config now runs two vitest
projects:
- `isolated` holds the seven files listed in `test/support/isolated-test-files.ts`, each with its
  own module graph as before.
- `shared` holds everything else, with `isolate: false`.

`test/isolated-test-files.test.ts` fails if a test file starts changing that state without being
listed, or stays listed after it stops. The shared set passed three shuffled orders (seeds 11, 222 and
3333). On a four-core VM with `CI=1` (two workers), the suite went from 130 s to 76 s wall, and import
time from 104 s to 24 s.

The first PR run of that change (41611916800) was OOM-killed (exit 137) in the 6 GiB job container.
Sampling the run's process tree (proportional set size) and the pod's `anon + shmem` from
`memory.stat` shows where the memory went. The vitest process, with both worker threads, peaked at
about 1.4 GB, only about 0.1 GB more than with `isolate: true`. The rest was CLI children: each
concurrent case in the four suites above spawns one of about 450 MB (tsx from source, `codegen`, a
served `up`), and at vitest's default `maxConcurrency` of 5 per worker about 14 were alive at once.
Peak anon was 5.71 GB with main's config and 5.93 GB with the shared projects. Both leave less than
the runner's own processes need under the 6.44 GB limit. hobo's config now sets `maxConcurrency: 2`.
The `--maxConcurrency` CLI flag does not reach `projects`, so it has to be set in the config. With that
setting, peak anon falls to 3.58 GB (about 4 children) and wall stays at 78 s, because the cases wait
on their child, not on the CPU.

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

A daemon restart lost two more. The worker logged `hobo_ci_isolated_worker_drained` with `remaining: 0`
while both jobs were still running, exited, and both jobs were lost. The drain had three defects:

- It counted leases whose `accountId` equalled the worker's provider account id. A lease's `accountId` is
  the customer account that owns the job, so nothing ever matched and the drain finished at once. A lease
  belongs to the worker when its offer does: an isolated-container offer whose `providerAccountId` is the
  worker (`workerOfferKeys`, keyed by account and offer id because offer ids are unique per account only).
- Nothing reconciled during the drain. A lease leaves `running` only when a tick sees its runner exit, and
  the drain had stopped ticking. Each check now runs `runtime.tick({ admit: false })` first, which inspects
  leases but takes no inbox delivery and reserves or launches nothing.
- The signal handlers were `process.once`. A supervisor that signals the whole process group, with
  `hobo ci serve --with-worker` forwarding the same SIGTERM, delivers it twice, and the second one found no
  listener and killed the process. They are `process.on` now; shutdown was already idempotent.

The default `HOBO_CI_WORKER_DRAIN_TIMEOUT_MS` is now 30 minutes, since the drain waits for running jobs
rather than only for launches. The supervisor's stop timeout (systemd `TimeoutStopSec`, Kubernetes
`terminationGracePeriodSeconds`) has to be longer, or it kills the drain itself.

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
  with skopeo, or without it pushes the layout to the local registry (`mise oci push --image-dir`) and
  `docker pull`s it. A missing GHCR token skips the published-image pull, and a failed GHCR login falls
  back to the native build instead of aborting it. The box's `docker load` rejected the layout
  (`open …/blobs/json: no such file`), because the classic image store reads only docker-save archives.
  It reaches the registry by its bridge address from inside a container, and streams the contract inputs
  into the candidate image.
  `:local` moves only after that contract passes. `skopeo` is also in `system-packages.txt` for the next
  image, and `evaluateCiRunnerContract` checks for it (`IMAGE_CONTRACT_COMMANDS`) only when it runs
  inside a freshly built candidate (`HOBO_CI_RUNNER_CONTRACT=live`). Every job's preflight runs the same
  contract, so requiring it there would refuse jobs on the image that predates it.
  `scripts/test/ci-runner-image-contract.test.ts` pins both halves: the manifest declares it, and the
  live contract checks it. Once the image had it, main run 41578806148 failed at the load:
  bookworm's skopeo pins Docker API 1.22 in its `docker-daemon:` transport, and the box's daemon
  refuses anything below 1.24. skopeo now writes a `docker-archive:` (docker-save format) and
  `docker load` reads that.
- **The image had no browser.** Main push run 41642427527 failed 1 of 2554 tests after 12m44s:
  `@hobo/code` `test/session-control-server.test.ts` launches Chromium, and Playwright looked for
  `~/.cache/ms-playwright/chromium_headless_shell-1234`, which nothing installs. The test's
  `resolveChromiumExecutable()` knew only the arm64 layout under one root and returned `undefined`
  when it found nothing, so Playwright's download hint was the whole error. The base image now
  downloads Playwright's pinned headless shell (revision and version from `playwright-core`'s
  `browsers.json`, sha256 per architecture) into `/opt/pw-browsers`, sets `PLAYWRIGHT_BROWSERS_PATH`,
  and installs the Debian libraries it needs. The live contract renders a page with it
  (`--dump-dom`, which reaches the libraries Chromium opens at runtime, not only the linked ones), and
  `ci-runner-image-contract.test.ts` fails when the pins drift from the installed Playwright or the
  Dockerfile. The helper searches both layouts under `PLAYWRIGHT_BROWSERS_PATH`, `/opt/pw-browsers` and
  `~/.cache/ms-playwright`, and throws with the fix when there is no browser rather than leaving the
  test to whatever Playwright does. The first run of #1673 showed the other half: its gate started at
  13:53:25, before the image job retagged `:local` at 13:55:20, so it tested the old image (no browser,
  and no `tmux`, which the `@hobo/code` git-terminal pane drives through the resident session runtime:
  76 failures reading `tmux availability unknown`). The image now carries `tmux` too (live contract,
  `IMAGE_CONTRACT_COMMANDS`), and `pr-gate` and `main-gate` declare `needs: ci-runner-image` with
  `!cancelled()`, so a run that changes the image inputs tests on the image it built, and a failed image
  build still runs the gate rather than skipping a required check. When the inputs are unchanged the
  image job is a short no-op, which is what the gates now wait for.
- **The git-terminal pane suites waited out their own deadline.** With tmux in the image, run
  41651600798 got past the old failures, but the pane suites ran for 427 s and 596 s, and two tests hit
  the 90 s timeout. tmux was not the cost: the pane only runs `tmux has-session` and never starts a
  server. The test harness read the pane's write count *after* sending a key. A key that opens a prompt
  writes its label inside `stdin.write` itself, so the harness missed that write and polled out a 20 s
  deadline, once per prompt key. The harness now takes the count before each key and resolves on the
  write event, then waits one `setImmediate` tick so the pane can leave `busy`. It has no deadline and
  no fixed gap, so a lost answer fails the test rather than being absorbed into a timeout. The git
  fixture is built once per file and copied per test, with `commit.gpgsign=false` in its own config.
  Both files ran 79 tests in 4.1 s locally, against about 600 s before.
- **A checkout fetch hung for 11.5 minutes.** In run 41659338892 the off-path job's `git fetch
  --depth=2` started at 15:08:41 and was still waiting when the run was cancelled at 15:20:12.
  `git-remote-https` was still alive at cleanup, and the fetch in every other job of that run took
  about 3 s. The step API showed checkout as done and `pnpm install` as running, which was wrong; the
  job log is authoritative. Git has no default transfer timeout, so a stalled connection held one of
  the box's two slots, and the PR impact gate queued for 8 minutes behind it. The workflow now sets
  `GIT_HTTP_LOW_SPEED_LIMIT=1000` and `GIT_HTTP_LOW_SPEED_TIME=30`, the same bound the pins already
  use. A stalled fetch now aborts after 30 s, and `actions/checkout` retries it. The same run's
  contract-guard `pnpm install` also sat for 130 s in linking with nothing to download. That points
  at disk contention on the box rather than the network, and is not addressed here.
- **The cold dev loop is bound by disk, not by the loop.** In run 41663178224 the cold-loop job failed on
  "No space left on device". In run 41667005120 its `pnpm install` took 3m51s (15:45:09 to 15:49:00),
  and the gate step was cut off by the 5-minute job timeout. The loop itself boots in about 15 ms, and
  the script runs in about 1 s. The job installed the whole workspace, copying 4.3 GB out of the store
  (another filesystem, so no hardlinks), then streamed 4.6 GB into the offline container. Both jobs
  that were slow in that run were writing gigabytes to the same disk. The job now installs only what
  the script imports, with `--ignore-scripts`. The stream is 2.24 GB, and an install, unpack and run
  rehearsal takes 12 s locally.
- **The image job rebuilt an image the box already had.** In run 41667005120 a `build.sh`-only change
  started a build that had not finished after 13 minutes. Earlier rebuilds on the same PR took 42–106 s.
  That change also replaced the shared local registry with a per-build one, so the full base was
  pushed again. That change has been dropped. The version tag hashes every image input, so `build.sh`
  now skips the build when `hobo-ci-worker:<version>` is already on the host, and `build.sh` is one of
  the hashed inputs. Preflight prunes only untagged images over a day old, so the layer cache survives.
- **"duplicate" in the worker log is not a stuck dedupe.** The poller reports a queued job as
  `duplicate` when its delivery id (`poll-<job>-<attempt>-q`) is already in the inbox, which is true of
  every job waiting for a slot. With every slot full, `launch()` leaves the lease `reserved`, and the
  next tick retries it. In that run, contract guard and secret scan waited because the two slow jobs
  held the slots, and longest-first admission puts 8–12 s jobs at the back.
- **Vitest inlined the TypeScript compiler.** `typescript/lib/typescript.js` is CJS, but es-module-lexer
  finds module syntax in it, so Vitest's externalization heuristic inlined it. Vite then transformed the
  9 MB file in each worker and logged `Failed to load source map for …/typescript.js` with an ENOENT
  stack, because the `typescript.js.map` it names is not shipped. The root `vitest.config.ts` now lists it
  under `server.deps.external`. `test:unit` locally (four forks): 69.2 s to 64.3 s, transform 31.4 s to
  20.0 s, two warnings to none, with 758/758 files passing both ways.
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

## Finding 9: a freed slot went to whichever job the worker saw first

Main push run 41584429317 (after #1651) waited about 9 minutes for a slot: both slots held
`artifact signing and install verification` jobs of the #1652/#1653 PR runs, whose `pnpm install` stalled
for 401 s. The box admitted demand in two arbitrary orders. Reservations, capped by the offer's
`concurrency`, followed `pending_jobs` ingestion order, so the PR jobs the poller listed first took the
slots. Launches followed the lease table's primary key, a random UUID. Nothing preferred the run that
gates every other merge.

`HostedRelay.dispatchPending` now sorts both loops by run event, then the run's `run_started_at`, then the
job id (`packages/ci-gh-actions/src/admission-order.ts`): `merge_group`, `push` and `workflow_dispatch`
first, then pull requests and any other event, then `schedule`. A run's event and start time are fixed for
an attempt, so each run is looked up once; a failed lookup ranks the job with pull requests, behind them,
and is retried on the next tick. Running jobs are never preempted, so a trunk job still waits for the
first slot to free, but it no longer waits behind PR jobs that queued before it. The box daemon has to be
redeployed on a main that includes this change.

## Finding 10: the job poller spent the installation's rate limit on finished runs

The worker reached the poller's floor (fewer than 300 calls left) and paused polling, so queued jobs
waited for the reset. Each poll (every 15 s) made three run-list reads plus one jobs read per run, and the
completed-runs list covers every workflow's runs from the last two hours, up to 50. With 50 completed runs
that is about 53 counted reads a poll, or about 12,700 an hour against a 5,000-an-hour installation
budget, almost all of it re-reading jobs that can no longer change. The lookback URL also embedded the
current time, so no two polls asked the same question.

`packages/ci-gh-actions/src/isolated-worker/github-job-poller.ts` now:

- sends `If-None-Match` with the last ETag on every read and reuses the cached body on a 304, which does
  not count against the limit;
- rounds the `created>=` lookback down to 10 minutes, so the completed-runs URL is the same between polls;
- stops reading a completed run attempt once every job in it was seen completed and ingested, and drops it
  from memory once it leaves the lookback. A re-run is a new attempt and is read again.

An idle poll now costs nothing, and a busy one costs one read per run whose jobs changed. The box daemon has
to be redeployed on a main that includes this change.

The status filter itself turned out to be unreliable. For run 41622562414, `?status=queued` answered
`total_count: 0` for more than 16 minutes while the unfiltered `/actions/runs?per_page=3` listed the run as
queued, and nothing in the logs said so: a non-OK read came back as an empty list, and the daemon logged a
poll only when it accepted a job or paused. The poller now also reads the newest 50 runs with no status filter
(same ETag rule, so it costs nothing while the list holds still and one read a poll while runs move) and
unions them with the filtered lists: a run not `completed` there has its jobs read, and a `completed` one joins
the completed-runs lookback. Every read GitHub refuses is logged as `hobo_ci_isolated_worker_github_read_failed`
with its path and status. Each poll summary also carries the queued `hobo` jobs it saw but did not newly
accept (`waiting`, as `run/job:result`, where the result is `duplicate`, `ignored` or `failed`). The daemon
logs a poll that accepted a job, refused one, failed a read or paused. It also logs one whose waiting jobs
changed, and repeats that line once a minute while the same jobs keep waiting.

## Finding 11: a run's long pole was admitted last

Main push run 41611050533 (149 s) queued four `hobo` jobs at once. They were admitted by ascending job
id: CI fabric contract guard (32 s) and Secret scan (14 s) took the two slots, then CI runner image
(40 s). Main full gate (85 s), the longest of the four, had the highest id and started 63 s after the
run was created. Two things kept #1655's order from preferring it.

- Within one run, the tiebreak after the event rank and the run's start time was the job id.
- Webhook intake reserved each job as its delivery was processed. A batch the poller ingested in one tick
  was therefore reserved in delivery order. Only jobs left pending went through the sorted
  `dispatchPending` loop.

Three changes fix this.

- `src/job-durations.ts` keeps an in-memory history keyed by repository and job name. It holds the last
  five successful durations, `completed_at − started_at`, and maps each job id to its name. Skipped and
  failed runs do not count.
- The pull-mode poller feeds every `hobo` job it reads into that history. It reads `name`, `conclusion`,
  `started_at` and `completed_at` from the `runs/{id}/jobs` lists it already fetches, so this costs no
  extra request.
- `createAdmissionOrder` now sorts by rank, then run start time, then expected duration (longest first),
  then job id. The hosted runtime sets `deferReservation`, so intake only queues a job, and the
  `dispatchPending` that ends every tick reserves the whole batch in that order.

A job with no history expects 0 and keeps the job-id order. After a daemon restart, the first poll
re-reads the completed runs in its two-hour lookback, which restores the history. Expected on the box: in
a run like 41611050533, Main full gate and the contract guard start first. Secret scan and the runner
image then follow on the freed slot while the gate runs. The run ends shortly after the gate's own finish, about 120 s
instead of 149 s. The box daemon has to be redeployed on a main that includes this change.

## Finding 12: main re-ran the tests its own PR had just passed

Main push 41671509710 (merge of #1675, 407 s) spent 288 s in Main full gate:

| Step | Time | What ran |
|---|---:|---|
| Checkout, preflight, cache restore | 10 s | |
| `pnpm install` | 23 s | store host-mounted |
| S0 gate set | 101 s | 14 `agent:check` lanes at concurrency 1; `turbo run test --filter=./packages/code` alone 79 s (78 of 82 tasks cached, `@hobo/code#test` a miss), `test:root` 13 s, `typecheck:root` 5 s, the other 11 under 5 s together |
| Workspace tests | 146 s | `dependent-tests.mts`: 7 whole suites 41 s (84 of 90 cached; `@hobo/code#test` replayed from the S0 run), `@hobo/hobo` subset 92 s (75 files whose imports reach `packages/code/src/rubberhose.ts`), `examples/self-host-yard` subset 9 s, three cached subsets under 1 s |
| Prune, save, trace | 8 s | |

The run's critical path was image job 91 s (its inputs changed in #1675), then the gate. The scoping was
right: the 75 `@hobo/hobo` files reach the changed source through real imports, and the docs-only edits
in `packages/ci` and `packages/ci-gh-actions` cost nothing on their own (`*.md` is outside the `test`
inputs). The waste was `@hobo/code#test`. #1675's PR impact gate (run 41669665020) ran the same lane on the
same tree eight minutes earlier (73 s, its only miss), but its cache entry was saved under the PR's ref,
and `actions/cache` never restores a PR ref's entries on main.

Fix: on the box, `.github/actions/turbo-cache` points `TURBO_CACHE_DIR` at a directory inside the
host-mounted pnpm store (`hobo-turbo-cache`), so every job (PR, merge group, main) reads and writes one
content-addressed cache and the `actions/cache` restore and save are skipped. Turbo's task hash here is
file content only (strict env mode, no task `env` keys), so a PR gate's result replays on main when the
merged tree matches. `scripts/ci/turbo-cache-prune.mts` prunes the shared directory by the same 7-day rule
and skips files another job's prune removed. Two jobs writing one hash can leave a truncated archive for
an instant; turbo reads that as a miss and runs the task (checked by truncating a build entry). No daemon
redeploy is needed: the pnpm store mount already exists.

Expected for a push like 41671509710: S0 drops by about 77 s (the `@hobo/code#test` replay), and the image
job is about 10 s once #1676's no-rebuild skip lands, so the run goes from 407 s to roughly 250 s. The
`@hobo/hobo` subset (92 s) is the floor for a change to `@hobo/code` source; the PR gate does not run it.

## Finding 13: GitHub gave the runner launched for main to an older PR job

Main dispatch run 41672800885 queued its Main full gate at 10:22 CST and waited while PR jobs held both
box slots. The worker already admitted trunk first (finding 9), so two things defeated it.

- **Labels decide, not the worker.** Every job asked for `hobo` and every JIT runner registered `hobo`.
  GitHub hands a new runner to a queued job whose labels it matches, and it picked older PR jobs. The
  worker chose when to start a runner, not which job took it, and a runner launched for main ran a PR
  job (`lease.actualJobId` records the swap).
- **PR leases filled the offer's concurrency.** The offer's `concurrency` equals the slot count, so with
  two PR leases active, a trunk job could not even be reserved until one finished.

The fix is in three parts.

- `push`, `workflow_dispatch` and `merge_group` jobs in `hobo-ci.yml` ask for `hobo-trunk`. They initially
  did this only while the repository variable `HOBO_CI_TRUNK_RUNNER` was `true`; finding 15 describes the
  default-on follow-up. The relay accepts exactly one label, `hobo` or `hobo-trunk`
  (`src/runner-labels.ts`). It re-reads the job's label before launch and passes it to the host. The box
  controller, the Vercel sandbox controller and the workflow bridge register the JIT runner with that
  label, so a `hobo-trunk` runner can only take a trunk job. `scripts/lint-actions.ts` allows
  `runs-on: hobo` and the one gated expression, so the variable can switch a job between the two hobo
  labels but cannot point it at a hosted runner.
- `HOBO_CI_WORKER_TRUNK_SLOTS` (then default 0) caps the active leases of the other runs at
  `HOBO_CI_WORKER_SLOTS − HOBO_CI_WORKER_TRUNK_SLOTS` (`generalLeaseLimit` on `HostedRelay`) while a
  trunk job waits; see the follow-up below for borrowing. Trunk is classified by the run's event, the same lookup the
  admission order already caches. Before the label-rank follow-up, a run whose lookup failed counted as
  a PR. The hosted runtime now keeps one admission order across ticks, because it rebuilds the relay
  every 2 s tick, and a per-relay cache made the cap look up the run of every active lease on every tick.
  A run is looked up again only until GitHub gives it a start time.
- Tests in `test/github-job-poller.test.ts` drive the poller, relay and container controller end to end:
  1. A trunk job queued after two PR jobs gets the first slot one of them frees, launched as `hobo-trunk`
     (see the follow-up below for why the PR jobs hold both slots first).
  2. A slot released mid-pass stays with the trunk job that just missed one.
  3. The real controller's JIT registration carries `hobo-trunk`.

**Rollout.** Redeploy the box daemon on a main that includes this change with
`HOBO_CI_WORKER_TRUNK_SLOTS=1`, then set `HOBO_CI_TRUNK_RUNNER=true`. Do them in that order: a daemon
that does not serve `hobo-trunk` would leave main's jobs queued.

**Follow-up: the kept slot is lent.** Keeping a slot idle serialized every PR run on the other one:
about six jobs each, one at a time, which put PR runs near the 20-minute line. The cap now applies only
while a trunk job is pending without a lease. With no trunk job waiting, PR jobs may take every slot. A
trunk job that arrives then waits for the first PR job to finish (running jobs are never preempted). It
is first in admission order, so it gets that freed slot ahead of any newer PR job. It also holds the
cap, so a lease released later in the same pass is not handed to a PR job either. The trade is at most
one PR job's runtime of trunk wait, only when both slots are busy with PR jobs, in exchange for PR runs
using both slots. Tests: `lends the trunk slot to pull requests until a trunk job waits…`, `keeps a lease
released mid-pass for the trunk job that just missed one`, and the uncapped variant, where admission
order alone still gives trunk the freed slot.

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
   Not done here. On trunk runs, the secret scan runs inside Main full gate in parallel with its checks,
   so a main push needs one fewer slot. Pull requests keep the separate required "Secret scan" job.

Risk to keep in mind: the box's pnpm store is a read-write host mount shared by every job, fork PRs
included (`forkPullRequestEnvironment: ci`). pnpm verifies tarball integrity against the lockfile on fetch,
but a job can still write into the shared store. Since finding 12 the turbo cache lives in that mount too.
It used to stay on `actions/cache` (scoped per ref) for this reason. That scoping kept PR results away from
main, but it did not keep a fork away from main's inputs: every job container also gets the host docker
socket (`HOBO_CI_MOUNT_DOCKER_SOCKET` defaults on), and with it a fork job can retag `hobo-ci-worker:local`,
the image the Main full gate runs in, or write any host directory. The turbo-cache action now hands the
shared cache only to same-repository jobs: a PR whose head repository is not this one (compared by
`full_name`, so a deleted fork's null head repo also counts) gets no `TURBO_CACHE_DIR` and uses the
per-ref `actions/cache` fallback, so no fork run reads main's entries or writes one main could replay.
That keeps an honest fork off the shared cache but stops nothing a malicious one does through the socket
or the store mount. The boundary that would matter is per-job socket and mount policy for fork PRs in the
box daemon.

## Finding 14: release PRs fanned out to 18 jobs on two slots

#1674 added the release pipelines. Its PR queued 18 `hobo` jobs between them:
- `release-code` queued contract, lint, a build cone, four Vitest shards, affected-image selection, and one image job.
- `release-hobo` queued contract, affected-image selection, and seven image jobs. `hobo-code` was again among them, so it was built in both pipelines.

Every job paid about 70 s of checkout and 20 to 40 s of install before its real work. That work was 13 to 18 s of tests per shard and 20 to 65 s per image. The old detector also selected every image on any lockfile, root `package.json` or `turbo.json` change.

| #1674 (before) | wait for a slot | run |
|---|---:|---:|
| release-code lint / contract / cone | 153 / 198 / 502 s | 96 / 105 / 112 s |
| release-code shards 1 and 4 | 130 and 295 s | 115 and 121 s |
| release-code shard 2 | — | 6.5 min in checkout, cancelled |
| release-code shard 3 and image | never got a slot | cancelled |
| release-hobo contract / affected | — | 122 / 58 s |
| release-hobo sdk / codegen | 397 / 746 s | 132 / 101 s |
| release-hobo remaining images | — | cancelled at about 1316 s |
| merge-queue contract guard (run 41711566157) | 636 s | 119 s |

Fix (#1685):
- **Affected images keyed by build inputs.** `scripts/ci/release-oci-affected.mts` hashes, for each image:
  - the tracked build files of its package's workspace closure, read from `pnpm-lock.yaml`, with tests and docs excluded;
  - that closure's slice of the lockfile;
  - the shared release and toolchain inputs;
  - its own manifest entry and any extra path-read inputs;
  - the key of its `FROM` image.
- **One PR job per pipeline.**
  - `release-hobo` builds its affected images in sequence, running the live OCI contract on each.
  - `release-code` runs lint, the unsharded `@hobo/code` suite through turbo, and the `hobo-code` image.
  - `hobo-code` is built only by `release-code`.

| #1685 (after; its workflow edits force every image) | wait for a slot | run | jobs |
|---|---:|---:|---:|
| release-code (`code-release`) | 12 s | 145 s: install 21 s, full suite 70 s (204 files, 5,990 tests), image 25 s | 1 |
| release-hobo (`release-contract`) | 253 s | 229 s: 6 images and 6 live contracts in 176 s | 1 |

Slot-time for the same work dropped from more than 1,100 job-s, much of it never finished, to 374 s. The job count dropped from 18 to 2. Both runs finished, in 158 s and 483 s of wall time, where #1674's were cancelled after more than 20 minutes. A PR that changes no image inputs now runs the contract tests and the suite only. The suite's turbo entry lands in the shared cache, so main's S0 lane can replay it. The 253 s wait was for slots held by other PRs' fabric jobs. That PR's own fabric run still waited 82 to 937 s, so slot count remains the next limit. More slots are not free: the host has 15 GiB, runs 2 slots × 6 GiB, and has peaked near 12 GiB (item 5 of "What is left to reach five minutes").

## Finding 15: trunk jobs starved for 16 minutes

Main push run 41720899087 queued three jobs at 21:20:26Z. None started until 21:36:36Z. Meanwhile every
slot that freed on the two-slot `hobo` box went to a pull-request job: starts at 21:21:48, 21:21:55,
21:23:17, 21:25:06, 21:26:17, 21:26:40, 21:27:58, 21:28:24, 21:29:20, 21:31:01, 21:35:59 and 21:36:08Z.
Trunk admission order alone therefore did not protect the next free slot.

Three mechanisms confirmed in the relay and stores explain it:

- `createAdmissionOrder` remembered a run only after `run_started_at` arrived. A later failed `getRun`
  returned `UNKNOWN` (pull-request rank, infinite start time), even when an earlier lookup had identified
  the run as trunk. The poller also discarded the `event` and `run_started_at` already present in its run
  lists.
- Under the shared `hobo` label, GitHub could assign the runner launched for trunk job T to PR job P. The
  store recorded `actualJobId = P` and removed P's pending row, but T's pending row had been removed when
  its original lease was reserved. `reserve` also returned that active lease for T, so T could not get a
  replacement until P finished and settlement requeued it.
- Lent-slot enforcement only refused new non-trunk reservations after trunk missed a lease. It did not
  reclaim non-trunk leases still in `reserved`, even though those had launched no host and could be
  cancelled safely.

The fix primes admission from the run lists without another GitHub request, remembers rank independently
of start time, and retains it across failed lookups. A swapped lease now makes its still-queued original
job pending and reservable again while the borrowed runner continues untouched. With
`HOBO_CI_WORKER_TRUNK_LEND=1`, a waiting trunk job cancels excess non-trunk `reserved` leases newest first,
requeues their jobs, and retries its reservation in the same pass; a lease with any host or runner evidence
is never reclaimed. Strict and lending modes both retain the non-trunk cap after trunk misses capacity,
and reserved leases launch in the same trunk-first admission order.

At that stage, label separation still required redeploying the box daemon with
`HOBO_CI_WORKER_TRUNK_SLOTS=1`, then setting repository variable `HOBO_CI_TRUNK_RUNNER=true` so GitHub
gave a `hobo-trunk` runner only to trunk work. The daemon change and `HOBO_CI_WORKER_TRUNK_LEND` setting
took effect only after that box redeploy.

The GitHub API confirmed the label root cause: every job of run 41720899087 requested `labels=["hobo"]`
because `HOBO_CI_TRUNK_RUNNER` was unset and the expression was opt-in. Trunk-capable CI and release jobs
now request `hobo-trunk` unless the variable is explicitly `false`, the daemon reserves one trunk slot by
default when it has at least two slots, and the trunk-only label proves trunk admission rank even when a
run lookup fails. PR-only jobs, including Secret scan (trunk history scanning now runs in Main full gate),
request plain `hobo`. JIT runners still register with exactly the label their job requested.

Merge-group run 41731777263 exposed the same swap after its runner took an older PR job: later queued
polls were inbox duplicates. Direct swapped-job requeue bypasses that marker, and Postgres queue dedupe
now also ignores the swapped lease, so the replacement launches with the original job's label while the
old lease continues the other job.

## Finding 16: merge_group skipped the gate that caught the red main

Run 41736273918 went red after #1689 merged through the merge queue. Main full gate's Workspace tests
caught a latent `@hobo/stations` fixture break introduced by #1631 and fixed by #1692. The PR impact gate
ran only turbo `test:unit` lanes, while `merge_group` ran just the contract guard among the affected CI
jobs; Main full gate neither ran on `merge_group` nor was required. Merge-group entries now run the same
affected S0 and dependent workspace-test gate as Main full gate inside the required PR impact gate, using
the merge group's base SHA. The PR impact gate requests `hobo-trunk` by default on `merge_group`, while
its `pull_request` runs continue to request `hobo`.

## Finding 17: a re-polled queued job was dropped as a duplicate

The poller uses constant `poll-<job>-<attempt>-q` delivery ids for unassigned queued jobs.
Once accepted, later polls returned `duplicate` without checking whether a pending job or active lease still covered the job.
Run 41738569286 had five jobs queued for over 17 minutes and logged as duplicates while 22–24 jobs waited.
The fix checks coverage locally and re-admits uncovered jobs through the relay at most once per minute per delivery id.
The Vercel relay webhook answers 202 `requeued` for such a re-admitted delivery.

## Finding 18: the contract guard held the slot Main full gate needed

Main push run 41747634569 took 109 s: image 00:33:06–00:33:12, contract guard 00:33:06–00:33:44, Secret scan 00:33:24–00:33:39, Main full gate 00:33:45–00:34:37.
The gate was runnable at 00:33:12 but waited 33 s for one of two slots; the guard's real work was 2 s and its other ~33 s duplicated checkout, preflight and install.
The guard now runs only on pull requests, while its two steps run after install in Main full gate and in PR impact gate on merge_group.
The PR-only guard requests plain `hobo`.
Expected saving: about 33–38 s of critical path on a main push and on merge_group.

## Finding 19: every job installed both CPUs' agent CLIs

`pnpm install --frozen-lockfile` takes 19–26 s per job on the box, and 44–46 s when both slots install at
once. Nothing is downloaded ("reused 1997, downloaded 0"); the time goes to writing `node_modules`.

- The store is the host mount `/pnpm-store` and the workspace is on the container's overlay, two
  filesystems, so pnpm cannot hard-link and copies every file.
- Root `package.json` set `pnpm.supportedArchitectures.cpu` to `["arm64", "x64", "current"]`, added with
  the docs-portal contract in #510 without a stated reason. `@agentv/core` (used by `provider-agentv` and
  ts-autocode's `training`) depends on `@openai/codex` and `@github/copilot`, whose native packages are
  190–280 MB per platform. Every job copied both CPUs' builds, about 1.1 GB, and could run one of them.

The setting is now `["current"]`. The lockfile does not change: it records every platform's optional
packages either way, and the setting only decides which ones are installed. No workflow, Dockerfile or
script uses another CPU's npm binary; the worker image installs inside its own build stage, on its own
platform.

Measured on an x86_64 cloud VM with the box's settings (`CI=1`, `package-import-method=copy`, no
`node_modules`, warm store, same lockfile): 15.8–16.8 s before and 12.6–12.9 s after, with
`node_modules/.pnpm` going from 4.5 GB to 3.4 GB.

Considered and not done:

- **Hard links from the shared store.** Putting the work directory on the store's filesystem would let
  pnpm hard-link (14 s instead of 18.9 s in the same test). A hard link is the store's own file, so a job
  that writes into `node_modules` would change it for every later job, fork PRs included. That widens the
  risk noted at the end of this document.
- **pnpm's global virtual store.** pnpm 10.33 ignores `enableGlobalVirtualStore` when `CI` is set; without
  `CI`, a warm install still took 13–14 s.
- **Skipping dependency build scripts.** `--ignore-scripts` saved about 4 s, though the scripts
  themselves run in under 1 s. The four packages in `allowBuilds` (`@ast-grep/cli`, `@bufbuild/buf`,
  `esbuild`, `protobufjs`) set up their native binaries in `postinstall`, and jobs run those tools.

## Finding 20: a workspace-wide change linted every package and failed on old findings

PR #1667 changed root `package.json`, so affected-lanes selected all 795 packages; turbo ran every package's `lint` (`biome check .`) with `--continue=never` and failed on `@hobo/pack-postgres-oci` (7 errors in files the PR never touched).
Main had 53 such errors across 9 packages because Main full gate never runs package lint.
This cleanup fixes them; a follow-up commit in the same PR makes PRs and main lint only changed files.
The rift debris test was host-tier-dependent and is now pinned to overlayfs, with a copy-tier sibling proving cloned files are parked.

## Finding 21: Main full gate waited for an image job that had nothing to build

Main push run 41762556455 took 107 s. The run was created at 02:43:10; CI runner image (mise oci) ran 02:43:28–02:43:40, spending 18 s waiting for a runner and then 12 s on a no-op because no image input changed. Main full gate ran 02:44:04–02:44:56.
Its `needs: ci-runner-image` kept it queued until the image job ended, and the box then needed about 24 s more for its next 15 s poll, container start and JIT runner start. About 36 s of the critical path was therefore the no-op image job plus the second launch.

The image job now skips a push when the payload's per-commit added, modified and removed file lists contain none of the image inputs; a skipped job satisfies `needs` immediately. Missing file lists and forced pushes fail open toward building, and a push that changes an input still builds and retags the image before Main full gate starts. The full-history secret scan moved from the image job to Main full gate so it still runs when the image job skips.

Expected saving: about 36 s of critical path on a push that leaves the image inputs alone. The remaining 18 s before the first job is the box's 15 s poll interval plus container start, a separate target.

## Finding 22: install time is linking, so the job starts from a prebuilt node_modules layer

Main run **41762556455** spent **19 s of the 52 s Main full gate** in
`pnpm install --frozen-lockfile --config.confirmModulesPurge=false`. The host-mounted store at `/pnpm-store`
was warm (`HOBO_CI_PNPM_STORE_MOUNTED=1`), so this downloaded nothing: the cost was copying and linking roughly
2,000 packages and 796 workspace importers into `node_modules`. A store-only cache cannot remove that work.

The deps layer builds those trees once per toolchain/deps key and starts eligible HoBo job containers with
them already at `/opt/actions-runner/_hobo_work/HoBo/HoBo`. The key covers every importer manifest, pnpm and
Node versions, platform, patches and config, and the deps Dockerfile/build script themselves. The build's fetch
stage has network access under lockfile integrity pins; installation and native rebuilds run in a separate
network-disabled build. A matching toolchain label selects the layer per lease, and `clean: false` keeps it
through checkout. Main full gate and PR impact gate compare `HOBO_CI_DEPS_LAYER` with the checkout's computed
key: an exact match skips `pnpm install`; every miss runs the ordinary frozen install. The daily scheduled Main
full gate always installs as the ongoing correctness verifier.

Run **41773556225** exposed the first implementation's miss and cleanup costs:

- `CI deps layer (pnpm)` failed after **5m26s**. `RUN pnpm fetch --frozen-lockfile` took **164 s** from an empty
  store, exporting the fetch-stage layers took **84 s**, and copying the install workspace took **21.8 s**.
- The final `find … -prune … -delete` failed because `-delete` enables `-depth`, which makes `-prune` ineffective.
- `PR impact gate` took **4m20s**, including **170 s** in its cold fallback `Install dependencies` step because
  no layer existed. Its checks also found the two readonly `deps-key.mts` assignments, now built immutably.

The fetch and offline install now share the persistent host store through the same BuildKit
`hobo-pnpm-store` cache mount. The install stage moves each `node_modules` tree and the `.git` skeleton to a
separate staging directory; the final stage copies only that directory, with no deletion pass and no fetch store
or staged manifests. A new build still must report `Already up to date` from
`pnpm install --frozen-lockfile --offline --config.confirmModulesPurge=false` before promotion.

Every event checks the exact local key first, then GHCR, and skips the build on either hit. A local hit only
computes the key, inspects and tags the image. A GHCR-only hit confirms the manifest and materializes the
node_modules-only image once. Existing keyed hits can be promoted on PRs; new PR candidates remain unpromoted
and unpublished. The gate's exact-match path runs only `scripts/ensure-ts-autocode-links.mts`, so its install
step is skipped. Expected local-hit work is a few seconds in the deps job and no install step in the gate; a
GHCR-only hit adds one registry pull but none of the 164 s fetch, 84 s fetch export or full build.

On main pushes, `ci-deps-image` runs only when a deps-key input changed or `ci-runner-image` ran. Missing commit
file lists and forced pushes build fail-safe; schedule and workflow dispatch always run. PR build scoping is
unchanged. Main full gate does not depend on `ci-deps-image`, so an unrelated push neither builds the layer nor
adds a trunk-slot wait.

## Finding 23: the trunk slot went to a runner a PR job could take

Main push 14f6dc03 (#1686) created **HoBo CI Fabric** run **41764685484** and **HoBo Pricing CI** run **41764685602** at 03:03:34Z. The fabric run's **CI runner image (mise oci)** job did not start until 03:05:39, a **2 m 04 s** wait. The pricing run's **@hobo/pricing affected gate** started at 03:07:26, a **3 m 52 s** wait. Both waited behind PR jobs despite `HOBO_CI_WORKER_SLOTS=3`, one strictly reserved trunk slot, and the trunk-label expression added by #1691.

The relay classified trunk capacity by run event. A push job asking for shared `hobo` was therefore exempt from `generalLeaseLimit` and could take the reserved slot, but its JIT runner also registered as `hobo`. GitHub could give that runner to the oldest queued PR job, which then occupied the trunk slot for its whole run while `hobo-trunk` jobs waited. The incident workflows made this concrete: `pricing-ci.yml` used plain `hobo` on push, as did `release-pricing.yml`, `dev-env-smoke.yml`, `examples-e2e.yml`, and the manual acceptance workflow.

The fix separates **ordering** from **capacity**. Run event still sorts push, dispatch, and merge-group work first, but only a job requesting `hobo-trunk` is exempt from the shared-label cap or eligible to reclaim an unlaunched general reservation. A trunk-event job on `hobo` is capped like PR work and logs `hobo_ci_trunk_job_on_shared_label` once, naming its repository, workflow, run, and job. Every trunk-capable box workflow now uses the same label expression as `hobo-ci.yml`; the `trunk-label-routing` Actions lint rejects shared `hobo` on trunk-capable jobs and rejects the expression on PR-only jobs. Other repositories served by the box must make the same workflow change.

A trunk-label job that cannot reserve now reclaims the newest general lease that is still `reserved` with no container, runner, or host run, in strict mode as well as lending mode. This also lets excess trunk demand take general slots ahead of queued PR jobs. Running PR jobs are never stopped. Prewarm was not a second cause: an idle warm container has no lease, does not count against `slots`, and is renamed and reused for the trunk launch. Reservation and reserved-launch ordering were already trunk-first; swapped jobs re-enter that same ordering with their current labels, and deferred reservation reorders each poller batch independently of ingestion order.

To protect the GitHub App's 5,000-request/h installation budget, the relay now caches each immutable served runner label by repository and job ID, prunes entries when leases become inactive, and treats failed lookups as general while retrying them on the next tick.

The target is a **~100 s main critical path** with the reserved slot going directly to a `hobo-trunk` runner rather than paying a PR job's full runtime. Regression tests drive the real relay and fake controller through the incident shape, strict preemption, running-job safety, and pre-warmed trunk launch.

The stage-gate `scanGroup` regression test previously waited for Node's exec'd leader to keep the symlink name, but Node 24.22 names its main thread `MainThread` during startup, overwriting `/proc/<pid>/comm`; its 20-second lifetime could also expire before cleanup, making the group kill fail with ESRCH (runs 41796130401 and 41796132887). The test now sets `process.title` after startup, signals `ready` only after observing the spawned `sleep 0` in Z state, stays alive until killed, and treats an ESRCH group kill as already exited, making readiness event-driven and cleanup idempotent.

## Finding 24: slot-only admission let the host OOM killer choose a victim

PR #1697's **CI fabric contract guard** died in `pnpm install` with exit 137 while neighbouring jobs ran; #1696's merge-queue run died in **Workspace tests**. The 16 GiB, no-swap box admitted three containers with an 8192 MiB Docker limit each: `3 × 8192 = 24576 MiB`, already above physical RAM before the daemon, Docker and page cache. Per-container limits did not bound their sum, and workflow heap settings did not bound the number of Vitest forks.

One class model now supplies both the admission request and the container's hard `--memory` and `--memory-swap` values. The default budget is `min(os.totalmem(), numeric /sys/fs/cgroup/memory.max) - HOBO_CI_WORKER_MEMORY_RESERVE_MB`. The reserve is at least 2048 MiB. An explicit `HOBO_CI_WORKER_MEMORY_BUDGET_MB` may lower, but never exceed, host/cgroup memory minus that reserve. Startup fails closed unless every general class fits outside the trunk reservation and the heavy trunk class fits the full budget.

| Class | Default hard memory and memory-swap | Node heap per process | Max Vitest workers | Exact-name assignments |
|---|---:|---:|---:|---|
| `light` | 3072 MiB | 1152 MiB | 1 | CI fabric contract guard, Secret scan, static release contracts and attest jobs |
| `standard` | 4096 MiB | 1664 MiB | 1 | the default for every unlisted job and the pre-warmed container |
| `heavy` | 6144 MiB | 1344 MiB | 3 | turbo build/test gates, OCI image jobs, the pricing gate and clean/Dagger bootstraps |

`HOBO_CI_WORKER_MEMORY_CLASS_<LIGHT|STANDARD|HEAVY>_MB` overrides a class; heavy also accepts the legacy `HOBO_CI_WORKER_MEMORY_MB` alias. Classes below 3072 MiB are rejected. The exact GitHub job name selects the class, and the admitted request is persisted on the lease and exported as `HOBO_CI_JOB_MEMORY_MB`. Active and reserved leases, legacy leases counted as heavy, and the warm container all consume the same budget. An active trunk lease replaces its reservation; warm admission cannot spend that reservation.

The incident box reports **15989 MiB**. With three slots and the default 2048 MiB host reserve:

- admission budget: `15989 - 2048 = 13941 MiB`;
- one heavy, one standard and one light container: `6144 + 4096 + 3072 = 13312 MiB`, leaving `629 MiB` of admission budget, so three mixed slots fit;
- two heavy containers: `2 × 6144 = 12288 MiB`, leaving `1653 MiB`, so even a 3072 MiB light third job waits;
- three heavy containers would need `18432 MiB`, exceeding the budget by `4491 MiB` before the host reserve.

Thus three slots never admit a set whose summed hard limits exceeds **13941 MiB**. The box can run three mixed-class jobs, but not three heavy jobs. A smaller job may backfill behind a non-fitting head job for 60 seconds (`HOBO_CI_WORKER_MEMORY_HOL_MS`) before the same rank waits behind it too. `hobo_ci_memory_admission_wait` / `hobo_ci_memory_admitted` expose the arithmetic; Docker-confirmed exit-137 OOM kills log `hobo_ci_container_oom` with the class.

Before install, `scripts/ci/memory-env.mts` reads the job cgroup limit, then `HOBO_CI_JOB_MEMORY_MB`, then host RAM. It writes `HOBO_NODE_OPTIONS=--max-old-space-size=<heap>` (GitHub blocks `NODE_OPTIONS` in `$GITHUB_ENV`), `HOBO_TURBO_CONCURRENCY=1`, and the repo-owned `HOBO_TEST_MAX_WORKERS`. The daemon independently computes the same heap from the admitted memory class and injects `NODE_OPTIONS` at container creation, so it reaches every Node process; workflows do not override it with a static value. A 768 MiB native/non-heap allowance leaves `limit - 768` for the turbo/Vitest parent and its workers: `workers = max(1, min(cpuCount, floor((limit - 768) / 1280) - 1))`, then `heap = min(3072, floor((limit - 768) / (workers + 1)))`. Therefore `(workers + 1) × heap + 768 <= limit`, including the parent heap. CI does **not** export `VITEST_MAX_WORKERS`: Vitest applies that variable after config, including after `fileParallelism: false`, overriding correctness-critical single-worker pins. `scripts/ci/vitest-max-workers.mts` instead resolves `min(configured cap, HOBO_TEST_MAX_WORKERS)`, and a config scan executes every single-worker config under the CI environment.

The daemon also defaults **`HOBO_CI_WORKER_MERGE_GROUP_LEASES=1`** and rejects zero or invalid values. It counts reserved and running merge-group leases by cached run event, leaves excess jobs queued with one `hobo_ci_merge_group_cap_wait` log per job, and admits them in order as capacity frees. Set the repository merge queue's **maximum pull requests to build** to **1** as the outer bound as well.

## Finding 25: inode exhaustion made PR installs fail with ENOSPC

The box reached **95% inode usage**, after which PR installs failed with `ENOSPC` despite disk-space cleanup. Byte-free space alone could not predict that failure. The third incident established the rate: every gate job left a fresh roughly 2,000-package `node_modules` in its per-job work directory, exhausting the box's inodes in about **30 minutes**. Worker admission now samples `statfs` on both Docker's data root and `HOBO_CI_WORKER_WORK_ROOT`, checking `(blocks - bfree) / blocks` and the `df -i` equivalent `(files - ffree) / files`.

Each job now bind-mounts `hobo-<lease-id>` under the work root as its Actions work folder. Container teardown removes that host directory, including `node_modules`, in a `finally` path after pass, failure, cancellation, runner/container crash or timeout. Startup invokes the same dead-work-directory reaper for crash recovery. A directory is eligible only when its lease is no longer active **and** Docker confirms that its container no longer exists. Live job directories, directories with an existing container, symlinks and unrelated directory names are never removed; inspection errors fail closed for that directory. `hobo_ci_work_dir_removed` records bytes and entries removed.

All jobs share the daemon's read-write, content-addressed pnpm store at `/pnpm-store`; jobs may add content but never prune it. `npm_config_package_import_method=hardlink` makes installs link rather than copy packages. Startup refuses a store and work root on different filesystems, because hardlinks cannot cross filesystems. The daemon runs `pnpm store prune` only when no active job holds the conservative whole-job install lease, so a prune cannot race an install.

When either usage on either root exceeds **85%**, and on scheduled GC at least every five minutes (`HOBO_CI_WORKER_GC_MS`, capped at 300000), the daemon removes every unused `hobo-ci-deps-fetch:*` intermediate, keeps only the two newest `hobo-ci-deps:<key>` images plus `hobo-ci-deps:local` and images used by running containers, prunes dangling images, and enforces the BuildKit cap regardless of age. Dead work directories are reaped by the same pass. After pruning, usage above **95%** for either bytes or inodes keeps the job queued. One structured `hobo_ci_inode_pressure` event per pressure episode records the root, usage percentages and whether bytes, inodes or both are above the hard limit. Sampling errors also refuse admission rather than risking another ENOSPC failure. The work root defaults to `${XDG_STATE_HOME:-~/.local/state}/hobo-ci/work`; the Docker root comes from `docker info --format '{{.DockerRootDir}}'`.

## Finding 26: image tags and young BuildKit entries defeated storage GC

Two redeploy-time leaks kept filling the box. Each changed runner content key left another roughly **2 GB** `hobo-ci-worker:v*` image, including temporary registry/OCI artifacts, and `docker builder prune --filter until=24h --keep-storage 10GB` exempted every cache entry newer than a day. The cache could therefore grow **13 GB between prunes** despite the nominal bound.

All runner build and release entry points now reuse the content-keyed tag. Worker GC retains only the current and previous keys, always protecting `:local` and images used by running containers; the build helper registry is ephemeral and its layout/archive artifacts are deleted. The daemon applies the same worker selection on every scheduled GC and under pressure. BuildKit pruning now uses `HOBO_CI_WORKER_BUILDER_CACHE_CAP` (default **4 GB**, legacy keep-storage variable accepted as an alias) with no `until` filter on scheduled/pressure GC and at the end of runner and deps builds.

## Finding 27: a completed merge-group lease still occupied the trunk slot

On 2026-11-04 the three-slot box ran one reserved trunk slot and two general slots (`generalLeaseLimit = 2`, strict `HOBO_CI_WORKER_TRUNK_LEND=0`). GitHub job timestamps showed this sequence (UTC):

| Time | Runner / demand | What happened |
|---|---|---|
| 06:16:47–06:17:50 | `hobo-d0156479`, `hobo-trunk` | merge-group **PR impact gate** ran |
| 06:17:55–06:18:31 | `hobo-6bf2a922`, `hobo` | PR job ran |
| 06:17:57–06:18:25 | `hobo-83ed240a`, `hobo` | PR job ran |
| 06:18:26 | two `hobo-trunk` jobs queued | **@hobo/pricing affected gate** and **Main full gate** queued on a main push |
| 06:18:31–06:21:34 | `hobo-41321f31`, `hobo` | PR job ran |
| 06:18:37–06:25:57 | `hobo-c544e34e`, `hobo` | PR job ran |
| 06:21:40–06:22:16 | `hobo-d9afa8f0`, `hobo-trunk` | Pricing started 6 s after a general job ended |
| 06:22:22–06:23:16 | `hobo-200aa381`, `hobo-trunk` | Main full gate started 6 s after Pricing ended |

Pricing therefore waited **3 m 14 s** after queueing even though the merge-group job had ended before it queued. It started only when general capacity freed; Main then serialized behind Pricing for another **42 s** instead of taking the trunk slot Pricing had left conceptually free.

The code path was completion reconciliation in `hosted-runtime.ts`. It asked GitHub whether a lease's job had completed only when `actualJobId > 0`. Before the poller attributes the job to its runner, that field is zero. If the runner-exit marker is also absent or cannot be probed, the original job's completion never authorizes reconciliation, so its `running` lease continues to consume offer concurrency and its container continues to count against `slots`. The failing regression reproduces exactly that state: the merge-group job is completed on the same runner, `actualJobId` is still zero, and no exit marker is available. The old code kept the lease active; queued trunk work could not reserve until another job released capacity.

For a trunk-labelled lease, reconcile now falls back to the original `jobId` when no actual job has been attributed. It force-stops only when GitHub says that job is completed **and its `runner_name` exactly matches the lease**. A swapped lease still checks its actual job, so this cannot kill the different job that borrowed its runner. General leases retain the exact-assignment requirement and incur no additional reads. The runner-exit marker remains the immediate path; the trunk completion check is the next-tick fallback when assignment attribution or the marker is unavailable.

The slot-accounting and admission-order candidates needed no change. A trunk job may already reserve a free general slot, while general work cannot borrow trunk capacity in strict mode. The incident regression now proves that Main launches while Pricing remains running as soon as a general runner exits. Prewarm remains lease-free and outside slot accounting.

A trunk job that cannot obtain a lease for more than **10 s** now emits one structured `hobo_ci_trunk_wait` event per wait episode, with `reason: "lease-capacity"`, `waitedMs`, `repository`, `runId`, and `jobId`. Wait state is shared across relay ticks and cleared when the job reserves or leaves the queue. This distinguishes lease starvation from GitHub polling and container launch delays in daemon logs.
## Finding 29: the full-scope gate re-ran the whole unit suite while turbo was cached

Main push run **41800198423** took **6m27s** (previously 97 s). Its S0 gate took **3m30s**, with about **180 s** in root `test:unit`: `pretest:unit` replayed the cached build graph, then `scripts/run-tests.ts --category=unit` executed the root and draft Vitest files again at `HOBO_RELEVANT_CHECK_CONCURRENCY=1`. Package build/test cache hits therefore did not make the full-scope S0 gate cheap.

The unit graph is strict parity with the current legacy selector: **758 files = 25 root Vitest + 1 root `node:test` + 732 draft**, excluding draft `node:test`-style files and the frozen live-repo test. Root Node files execute after Vitest in their assigned cached shard. Four root shards use stable path hashes; four draft shards split by proof directory (technical, experience, epic, project). Production `packages/**` suites remain in Workspace tests, and `scripts/test/` remains in `test:scripts`. A shared turbo dependency runs the same 136 builds as the old pretest; exclusion-only inputs avoid hashing the root tree merely to track those dependencies.

`scripts/lib/unit-test-coverage.ts` proves exact set equality in both directions, rejects duplicate shard assignments, and verifies every selected file is in its shard's turbo inputs. The complete graph has 145 tasks: 136 builds, one dependency task, and eight test shards. Worker caps follow main's `min(configured, memory)` logic; turbo parallelism follows `HOBO_TURBO_CONCURRENCY`, and root workers honor `HOBO_TEST_MAX_WORKERS` then `HOBO_RELEVANT_CHECK_CONCURRENCY`.

Serial validation used `HOBO_TURBO_CONCURRENCY=1` and `HOBO_TEST_MAX_WORKERS=1`, with no source changes between runs:

| Lane | First run | Second (warm) run | Second-run cache |
|---|---:|---:|---:|
| `test:unit` | 165.9 s (137 / 145 cached) | **2.5 s** | **145 / 145 cached (FULL TURBO)** |
| `check:all` | 36.6 s (warm) | not rerun | unit graph fully cached |

The first merged unit run missed only the eight test shards whose runner/selection inputs changed; all 136 builds and the dependency task were cached. The second was fully cached. The warm full-scope gate is therefore under 60 seconds. Its measured steps were:

| Warm `check:all` step | Seconds |
|---|---:|
| `lint:boundaries` | 0.6 |
| `lint:test-deps` | 9.4 |
| `architecture:guard:all` | 1.3 |
| `konsistent` | 0.8 |
| `lint:docs` | 1.1 |
| `design:lint` | 1.4 |
| `draft:artifacts` | 0.6 |
| `draft:cascade` | 0.7 |
| `skills:mirror-check` | 0.6 |
| `promotions:check` | 0.6 |
| `case:check` | 0.6 |
| `test:schema` | 16.4 |
| `test:unit` | 6.0 |
| `test:behavior` | 2.9 |
| `standards:check` | 0.7 |
| `licenses:check` | 0.8 |
| `docs:coverage` | 0.5 |
| `docs:freshness` | 0.5 |

The remaining multi-second non-cached steps are `test:schema` and `lint:test-deps`; they stay unchanged in this PR.

## Finding 30: the site Vitest config re-inlined the TypeScript compiler

Merge-group run **41828663878** timed out the browser-station catalog test after **45.773 s**. The catalog statically reaches `scanDeclaredTrainables` through `synthesize-try-runtime.ts`; its `ts-autocode-grounding` dependency imports the **9 MB** `typescript.js` compiler. The root Vitest config already externalizes that file (Finding 7), but the site's separate config did not inherit the rule, so Vite's SSR pipeline transformed the compiler and warned about its missing source map.

The site config now applies the same `server.deps.external` rule, leaving the compiler on Node's native loader without changing catalog behavior. With four CPU hogs and the CI test environment, the catalog test fell from **4,735 ms to 740 ms**; its file fell from **5.19 s to 1.17 s** (transform **3.38 s to 235 ms**, import **223 ms to 191 ms**). The full 19-file site suite fell from **10.22 s to 3.89 s** (transform **11.04 s to 1.73 s**, import **18.67 s to 4.20 s**), with all 106 tests passing and the source-map warning gone.
