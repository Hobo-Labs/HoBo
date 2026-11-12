---
type: CI Performance Finding
title: "Finding 102: dead JIT runner shard two checkout"
description: "Shard 2 stayed on a box runner whose container had exited; admission reserved a second lease without launching."
tags: [hobo, ci, performance, worker, jit-runner, github-api]
---

# Finding 102: dead JIT runner shard two checkout

## Evidence

Run [43008157463](https://github.com/Hobo-Labs/HoBo/actions/runs/43008157463) on `6905b85b0` (scheduled HoBo CI Fabric):

| Signal | Value |
| --- | --- |
| Failed job | Main workspace test shard 2 — [job 130481461637](https://github.com/Hobo-Labs/HoBo/actions/runs/43008157463/job/130481461637) |
| Symptom | Checkout stalled; job bound to dead JIT `hobo-e2ac3917-9cb0-409b-abd2-8f757d2ab809` |
| Sequence | Box reserved Main full gate for `e2ac3917`; ARC took full gate; GitHub assigned shard 2 to still-registered `e2ac3917` |
| Worker | Memory admission wait ~313s (`host-available` ~2414 MB); second reserve at ~445s `queuedToReserved`; no launch |

## Cause

1. **Registration outlived container** — empty exit / settle removed the lease without deleting the GitHub JIT runner, so the name stayed eligible for assignment.
2. **No ghost check at reserve** — admission reserved shard 2 while GitHub already showed `in_progress` on the dead runner.
3. **Settle blocked on active assignment** — `settleStopped` returned early when GitHub still held an active binding, without deregistering when the container was already gone.

## Fix

- Deregister the box JIT runner on isolated settle and when a dead container still has an active GitHub binding (`hobo_ci_jit_runner_deregistered`, `hobo_ci_jit_runner_ghost_released`).
- Before `store.reserve`, skip duplicate custody and clear ghost bindings (`decideGhostBoxRunnerBinding`, `hobo_ci_jit_runner_ghost_binding_cleared`) — no workflow cancel, no ARC/GitHub-hosted runners touched.
- Stall recovery (finding 101) uses single-job `rerun` only on main push / merge_group; never `force-cancel` or `rerun-failed-jobs`.

## Measure

On the next two-slot main Fabric push with ARC taking trunk: no shard job `in_progress` on a `hobo-<uuid>` runner without a live container; no second `hobo_ci_job_reserved` for the same `jobId` while GitHub shows an existing binding; checkout stalls fail within one runner-loss timeout, not ~20 minutes.
