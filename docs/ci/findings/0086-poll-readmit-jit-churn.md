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

## Fix

- Classify runner custody (`box` vs `foreign`).
- `yieldForeignRunnerCustody` cancels isolated leases without `queueInside` and deletes pending demand (`withdrawQueuedJob`).
- Skip `queue`/`reserve` when an active lease already covers the job or GitHub names our JIT runner.
- Poll delivery ids hash **foreign** runner names only; box JIT and unassigned share one id.
- Treat `requeued` and `foreign-runner` as quiet coalesce results.
