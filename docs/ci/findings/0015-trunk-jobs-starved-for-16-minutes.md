---
type: CI Performance Finding
title: "Finding 15: trunk jobs starved for 16 minutes"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 15: trunk jobs starved for 16 minutes

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
