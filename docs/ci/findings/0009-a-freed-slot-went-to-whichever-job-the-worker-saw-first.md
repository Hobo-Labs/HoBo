---
type: CI Performance Finding
title: "Finding 9: a freed slot went to whichever job the worker saw first"
description: "Isolated HoBo CI Fabric performance finding."
tags: [hobo, ci, performance]
---

# Finding 9: a freed slot went to whichever job the worker saw first

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
