---
type: CI Ops Finding
title: "Finding 108: drain stale reservation"
description: "Box drain hung on reserved leases with no containers after GitHub cancelled the run; repeat SIGTERM did not exit."
tags: [hobo, ci, worker, drain, redeploy]
---

# Finding 108: drain stale reservation

## Evidence

Box worker redeploy to `c7ec8d449`: drain **~13 minutes** with two in-flight leases and **no containers**. One was reserved CI deps (`130580539807`) on superseded PR run [43037573989](https://github.com/Hobo-Labs/HoBo/actions/runs/43037573989). GitHub had already cancelled that run. Repeat **SIGTERM** / **SIGINT** did not exit until force-stop.

## Cause

`lease-reconciler` counted every `reserved` lease as live for drain regardless of GitHub state or container inventory, so reserved JIT registrations blocked `waitForIsolatedWorkerDrain` until the global drain timeout (default 30–120 minutes).

## Fix

- Reconcile (normal and drain) checks GitHub run/job state and cancels terminal reservations, enqueueing orphan-runner cleanup when needed.
- `HOBO_CI_WORKER_DRAIN_NO_CONTAINER_MS` (default **60s**) caps drain wait for leases that never reach a live container.
- Second **SIGTERM**/**SIGINT** during drain exits when no `hobo-*` container is running.
