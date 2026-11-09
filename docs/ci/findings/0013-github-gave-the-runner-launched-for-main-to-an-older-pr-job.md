---
type: CI Performance Finding
title: "Finding 13: GitHub gave the runner launched for main to an older PR job"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 13: GitHub gave the runner launched for main to an older PR job

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
