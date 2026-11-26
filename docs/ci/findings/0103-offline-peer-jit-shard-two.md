---
type: CI Performance Finding
title: "Finding 103: offline peer JIT shard two"
description: "Shard 2 bound to a peer-host box JIT that went offline; witness workers waited on storage without releasing the binding."
tags: [hobo, ci, performance, worker, jit-runner, fleet, github-api]
---

# Finding 103: offline peer JIT shard two

## Evidence

Main push run [43013191616](https://github.com/Hobo-Labs/HoBo/actions/runs/43013191616) on `cbd6ea798` (post-#1877):

| Signal | Value |
| --- | --- |
| Failed job | Main workspace test shard 2 — [job 130498617302](https://github.com/Hobo-Labs/HoBo/actions/runs/43013191616/job/130498617302) |
| Symptom | Checkout on peer JIT `hobo-37c472a9-080d-4c9f-ae64-07de19b0fff8`; runner offline while job still `in_progress` |
| Witness | Another box worker logged `hobo_ci_trunk_wait` `reason=storage` for the same job (~20m limit) |

## Cause

#1877 ghost deregister ran only at local settle and before reserve **after** storage/memory gates. A job already bound to a **peer** box JIT never reached that path while the witness starved on storage.

## Fix

- Probe GitHub runner `status` (`online` / `offline`) for box JIT bindings this host does not host.
- **Minting host** (shared relay lease still active): owns container stop + deregister on reconcile when the container dies.
- **Fleet witness**: may deregister only when GitHub reports the runner **offline**; online peer runners are never touched.
- Witness recovery runs before storage/memory admission and on `in_progress` webhooks; optional main-gate job `rerun` uses the same stall policy (no workflow cancel).

## Measure

On the next multi-host main Fabric push with a peer box JIT failure: no shard stays `in_progress` on an offline `hobo-<uuid>` runner past one witness tick + runner-loss timeout.
