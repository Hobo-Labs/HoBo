---
type: CI Performance Finding
title: "Finding 86: poll readmit jit churn"
description: "Coalesce without fleet custody dedupe re-ingested jobs another hobo runner already held, repeating isolated reservations."
tags: [hobo, ci, worker, polling, fleet]
---

# Finding 86: poll readmit jit churn

## Evidence

After the Finding 85 coalesce fix, box workers repeated JIT registration for the same queued job every ~15–20 s (#1814 job `130022163439`: 27 pickups; #1792/#1816 Fabric runs starved). GitHub had already bound another fleet runner on the shared `hobo` label (`hobo-runner-*` on Hostinger ARC, another box's `hobo-<uuid>`, or mesh peers).

## Cause

1. Poll `deliveryId` included a hash of **this worker's own** `hobo-<lease-uuid>` runner name once GitHub reflected JIT registration, so each poll looked like a **new** webhook and re-queued demand.
2. Duplicate **requeue** ignored **dispatching/claiming** reservations and custody held by **any other** `hobo` runner, so poll coalesce still re-ingested after every `requeued` result.

## Fleet context: shared `hobo` is intentional

HoBo CI is a **fleet mesh**: many nodes carry the `hobo` label (box workers, Hostinger ARC, future mesh members). GitHub assigns each queued job to **one** online runner among them. That cooperation is a product feature, not a misconfiguration.

The defect was **this worker fighting the mesh**—treating “another fleet member took the job” as local unmet demand and re-admitting in a loop—not the shared label itself.

## Why JIT runners exit in seconds without work

Isolated JIT containers run `./run.sh || true`. When GitHub assigns the job to a **peer** runner, this box's JIT never receives work, exits quickly, writes `/tmp/hobo-ci-runner-exited`, and reconcile settles the lease.

Registration still succeeds (`runner_group_id` and labels are correct). The runner simply lost the dispatch race fairly. **Before custody fixes**, settle treated “job still `queued`” as **unmet demand** and `queueInside` re-admitted it; Finding 85 coalesce re-poll amplified that into ~35s pickup loops (`hobo_ci_job_pickup`).

## Fix (fleet cooperation)

Each worker must treat a job taken by **any other** `hobo` runner as normal fleet behavior:

- **Classify custody** (`box` = this host's JIT `hobo-<uuid>`; `foreign` = any other fleet runner name GitHub reports).
- **Yield before JIT**: `getJob` before `generate-jitconfig`; if custody is `foreign` or the job is `in_progress` on a peer, cancel this host's lease (`hobo_ci_launch_yielded_foreign_runner`)—do not register another JIT.
- **Withdraw, don't requeue**: `yieldForeignRunnerCustody` and `settleStopped` call `withdrawQueuedJob` instead of `queueInside` when GitHub names a peer runner; **release the slot** (cancel isolated leases covering the job).
- **Dedupe admission**: skip `queue`/`reserve` when an active lease on this worker already covers the job, or when GitHub names **this** box JIT runner.
- **Poll coalesce**: delivery ids hash **peer** runner names only (this box's JIT and unassigned share one id); treat `requeued` and `foreign-runner` as quiet coalesce results.

Coalesce-only deploys without this bundle **increase** churn (box telemetry 2026-11-10: 8→10 pickups / 3.9 min, jobs `130022163396` / `130017909867` repeating ~35s).
