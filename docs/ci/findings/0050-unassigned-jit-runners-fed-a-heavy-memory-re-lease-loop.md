---
type: CI Performance Finding
title: "Finding 50: unassigned JIT runners fed a heavy-memory re-lease loop"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 50: unassigned JIT runners fed a heavy-memory re-lease loop

On 2026-11-04, **15 jobs** were logged as duplicates and #1709's **PR impact gate** was leased **14 times** without GitHub assigning its runner. Each cycle reserved another heavy slot while the original job stayed queued, and the babysitter repeatedly force-cancelled stuck runs. A GitHub Actions assignment incident during the same period made the failure mode broader: continued launches could not produce assignments, but the worker kept creating runners anyway.

The exact pre-fix lifecycle was: `dispatchPending` reserved the job's full memory class; `container-controller` created a full-memory JIT container and left `actualJobId=0` while GitHub never assigned it. No assignment path settled that idle runner. If the runner exited without taking a job, its exit marker made reconciliation stop/remove the container and settle the lease with the still-queued job as unmet demand. `dispatchPending` in that same tick then reserved and launched it immediately again. A runner that stayed idle had no local idle deadline at all. The Docker `timeout-ms` value was only a label, not an enforcement path. Poller delivery IDs then reported **duplicate** whenever pending demand or an active lease covered the job; an uncovered duplicate queued delivery triggered the hosted runtime's 60-second GitHub recheck. The store already deduped ordinary same-job reservations, but mismatched leases remained indexed under the original job, and there was no relaunch backoff or queue-wide assignment-stall guard.

A fake-GitHub/SQLite reproduction drove four poll/runtime ticks with one never-assigned job and observed **four leases**, proving the loop before the fix. The fix makes the store re-key mismatched leases by `actualJobId`, dedupe original and actual identities, and serialize Postgres reservations per job. Webhook plus poller intake therefore has one live lease per job. Mismatched assignment returns the original target to pending demand without counting an unassigned attempt.

The worker now stops an unassigned full-memory runner after **60 seconds**, releases its lease, and applies per-job relaunch backoff of 30 seconds, 1 minute, 2 minutes and 4 minutes with ±25% jitter, capped at 5 minutes. `hobo_ci_job_relaunch_backoff` records each attempt. Three consecutive unassigned leases park the job with one `hobo_ci_job_unassigned_parked` event until assignment, a GitHub `status`/`updated_at`/attempt change, or cap expiry; assignment resets the counter. Dynamic memory enlargement was rejected because poll-observed assignment cannot guarantee a resize before steps. Two or more queued jobs with no assignment for two minutes trigger one `hobo_ci_github_assignment_stall` per episode and only one probe runner per label until the first assignment. Trunk-first ordering and fail-safe Docker reconciliation are unchanged.

Regression coverage includes the original N-tick loop, backoff windows and the three-attempt park, state-change and assignment recovery, idle heavy-memory release, duplicate webhook/poller intake, mismatch re-keying, one-probe stall behavior and recovery, plus duplicate-delivery rechecks after an earlier lease becomes terminal. All external services remain fake in tests.
