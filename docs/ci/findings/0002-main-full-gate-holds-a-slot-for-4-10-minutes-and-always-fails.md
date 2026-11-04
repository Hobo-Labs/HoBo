---
type: CI Performance Finding
title: "Finding 2: Main full gate holds a slot for 4–10 minutes and always fails"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 2: Main full gate holds a slot for 4–10 minutes and always fails

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
