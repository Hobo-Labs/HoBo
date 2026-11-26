---
type: CI Performance Finding
title: "Finding 114: sigterm drain counted non-job work"
description: "Box worker SIGTERM drain blocked on reserved leases and inbox/tick promises with no live job container."
tags: [hobo, ci, box-worker, drain, sigterm]
---

# Finding 114: sigterm drain counted non-job work

## Evidence

On redeploy the box worker logged `hobo_ci_isolated_worker_drain_started` with `inFlight: 1` and `timeoutMs: 7200000`, then went quiet for 10+ minutes with no job container or child process running.

## Cause

Drain `inFlight` used `liveWorkerLeaseIds.size`, which includes memory **reserved** leases and other journal holds without a live worker container. Shutdown also awaited unbounded `tick` / inbox promises before the job drain loop.

## Fix

- Reconcile reports `drainJobInFlight` (leases with live containers or in-flight launches + running `hobo-*` containers only).
- SIGTERM bounds background tick/inbox/poll/gc/orphan work to **30s** via `awaitWorkerBackgroundDrainIdle`, logging `hobo_ci_drain_progress`.
- Job drain loop logs the same event with `phase: jobs`; reserved-without-container stops counting toward `drainJobInFlight` immediately on drain.

## Measure

Idle SIGTERM reaches `hobo_ci_isolated_worker_drained` within background bound + reconcile, not multi-hour `drain_waiting` on ghost `inFlight: 1`.
