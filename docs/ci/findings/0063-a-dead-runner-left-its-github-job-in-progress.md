---
type: CI Performance Finding
title: "Finding 63: a dead runner left its GitHub job in progress"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 63: a dead runner left its GitHub job in progress

## Evidence

PR #1720, run 41924222184 attempt 2, started the **artifact signing and install verification** job at 22:46:19 on ephemeral JIT runner `hobo-811c5018-...`. The runner container disappeared, but GitHub kept the job `in_progress` with no live container. A human cancelled it at 23:01:19, 15 minutes after it started.

A second orphan affected #1720. Run 41931792986 job 126930246249, **Secret scan**, waited 1,149 seconds for memory admission and started at 23:35:03 on runner `hobo-e45c19a3-5ae3-413a-b2ac-4d3101a0371c`. Checkout and preflight ran, then **Scan git history for secrets** began at 23:35:10 and never progressed. GitHub kept the job `in_progress` until a human cancelled it at 23:50:04.

## Cause

The box worker released its local lease and slot after the container went missing or exited, but it did not release the corresponding GitHub job. Deleting the runner registration returned 422 because GitHub still considered the runner busy. GitHub can keep a lost runner's job `in_progress` for more than ten minutes, so local capacity recovery did not recover the workflow.

The first recovery implementation keyed candidates by the lease's reserved job. A JIT runner registered with the shared `hobo` label can receive a different queued job, recorded as `actualJobId`. Checking the reserved job then saw it queued or assigned elsewhere and dropped the candidate while the actual job remained orphaned. Detection also depended on settlement through a lease that was still active.

## Fix

Candidates now use `actualJobId` when present and obtain that job's run ID during confirmation. Each reconciliation sweeps only the worker's active leases for an actual job whose runner name matches `hobo-<leaseId>` and whose container is missing or dead. The sweep reuses the tick's Docker inventory and makes no additional GitHub calls. Exited containers do not enter the sweep. Normal exit-marker and exit-code-zero settlements enqueue nothing; failed nonzero-exit and OOM settlements enqueue through the controller.

Later ticks confirm that the actual job remains `in_progress` on the same runner for at least 60 seconds. The worker then deletes the runner registration, accepting the expected busy 422, force-cancels the actual run, and waits for completion. Completed `pull_request` and `push` runs receive one failed-jobs rerun per run attempt. Merge-group runs are not rerun; their pull requests need to enter the merge queue again.

Candidates whose jobs complete, return to the queue, or change runners are dropped. GitHub failures are retried on later ticks. The in-memory candidate set is bounded and expires after 30 minutes. Active leases re-feed the sweep after restart, while cancelled-lease candidates survive only in the current process through controller settlement. If that in-memory candidate is lost, GitHub's lost-runner timeout remains the fallback.

## Verification

The orphan-job Vitest suite covers normal completion, the confirmation grace, runner mismatch, cross-assigned job and run attribution, the delete-422 and force-cancel sequence, one pull-request rerun, merge-group skipping, retry after a 5xx response, expiry, and idempotence across ticks. Lease-reconciler tests cover the active-lease sweep with one Docker inventory, non-worker runner names, running containers, missing and dead containers keyed by actual job, and no candidate for an exited container. No test reads the full lease journal. The controller suite covers crash detection and verifies that a normal exit-marker settlement enqueues nothing. Package typechecking, Vitest, Biome, and changed-file anti-slop lint validate the implementation.
