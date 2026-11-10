---
type: CI Performance Finding
title: "Finding 86: poll readmit jit churn"
description: "Coalesce fixes re-ingested queued jobs while a JIT runner or foreign ARC assignment already held custody, repeating 4 GB reservations."
tags: [hobo, ci, worker, polling]
---

# Finding 86: poll readmit jit churn

## Evidence

After the Finding 85 coalesce fix, box workers repeated JIT registration for the same queued job every ~15–20 s (#1814 job `130022163439`: 27 pickups; #1792/#1816 Fabric runs starved). GitHub later assigned ARC runners (`hobo-runner-*`) sharing the `hobo` label.

## Cause

1. Poll `deliveryId` included a hash of **our own** `hobo-<lease-uuid>` runner name once GitHub reflected JIT registration, so each poll looked like a **new** webhook and re-queued demand.
2. Duplicate **requeue** ignored **dispatching/claiming** reservations and foreign runner custody, so poll coalesce still re-ingested after every `requeued` result.

## Why JIT runners retire in seconds without the job

JIT containers run `./run.sh || true`. When GitHub assigns the queued job to **another** online runner with the same label (`hobo` — including ARC `hobo-runner-*` on a shared group), the box JIT never receives work, `run.sh` exits quickly, writes `/tmp/hobo-ci-runner-exited`, and reconcile settles the lease.

That is usually **not** a wrong JIT label or `runner_group_id` mismatch (registration still succeeds). It is **label collision + GitHub dispatch** to whichever runner wins the queue. Box then treated “job still `queued`” as **unmet demand** and `queueInside` re-admitted it; Finding 85 coalesce re-poll amplified that into ~35s pickup loops (`hobo_ci_job_pickup`).

## Fix

- Classify runner custody (`box` vs `foreign`).
- `yieldForeignRunnerCustody` cancels isolated leases without `queueInside` and deletes pending demand (`withdrawQueuedJob`).
- Skip `queue`/`reserve` when an active lease already covers the job or GitHub names our JIT runner.
- Poll delivery ids hash **foreign** runner names only; box JIT and unassigned share one id.
- Treat `requeued` and `foreign-runner` as quiet coalesce results.
- **Pre-JIT** `getJob`: if custody is `foreign` or the job is `in_progress` on another runner, cancel the lease (`hobo_ci_launch_yielded_foreign_runner`) instead of registering another JIT.
- **settleStopped**: do not `requeue` when GitHub still shows `queued` but names a foreign runner; `withdrawQueuedJob` instead.

Coalesce-only deploys without the custody/dedupe/yield bundle **increase** churn (box telemetry 2026-11-10: 8→10 pickups / 3.9 min, jobs `130022163396` / `130017909867` repeating ~35s).

**Ops follow-up:** confirm ARC runners intended for isolated-only work use a distinct label (e.g. `hobo-arc`) so they do not compete with box JIT for `hobo`-labeled jobs.
