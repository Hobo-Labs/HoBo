---
type: CI Performance Finding
title: "Finding 99: main gate job pickup latency"
description: "Green main Fabric runs still paid tens of seconds between GitHub queue and box reservation when ingress waited for lease reconcile and poll accept did not tick."
tags: [hobo, ci, performance, main-gate, worker, dispatch]
---

# Finding 99: main gate job pickup latency

## Evidence

Run [42994817738](https://github.com/Hobo-Labs/HoBo/actions/runs/42994817738) on `2bc142ab9` (2026-11-11) finished **7m56s** green. Job walls summed to under five minutes, but queue-to-start gaps dominated:

| Job | Run time | Queued → started (approx.) |
| --- | --- | --- |
| CI deps layer | ~12s | ~64s after route |
| Main workspace test shard 2 | ~1m40s | ~3:27:15 CST |
| Main workspace test shard 0 | (sibling) | ~2m after shard 2 (~3:29:04 CST) |
| Main gate finish | ~18s | ~75s after last shard |

## Cause

1. **Deferred reservation** — admitted jobs queue on webhook/poll ingest; `dispatchPending` ran only after the full lease-reconcile pass, so a slow reconcile delayed every dependent trunk job in the same tick.
2. **Poll → inbox without tick** — job poll could `accept` many `workflow_job` deliveries while the 2s worker tick was idle, leaving dependents in the store until the next reconcile window.
3. **Shard admission order** — within one Fabric push, workspace shards were sorted by learned duration before shard index, so capacity filled out of shard order and magnified start skew on a two-slot box.
4. **Prewarm only on queued trunk** — JIT containers prewarmed when poll saw a queued trunk job on the newest main push, not when a parent job completed and children became queueable.

Finding 87 / [#1819](https://github.com/Hobo-Labs/HoBo/pull/1819) (poll coalesce strand) is prerequisite mesh hygiene; it is already on `main`. This finding addresses the remaining dispatch latency after ingest.

## Fix

- **Early dispatch** — after a webhook batch queues or reserves work, run `dispatchPending` before lease reconcile (final dispatch unchanged).
- **Poll coalesced tick** — when job poll reports `accepted > 0`, run `runTick()` immediately so inbox deliveries reserve without waiting for the poll interval.
- **Shard order** — for the same `runId`, `Main workspace test shard N` jobs sort by `N` before duration ties so one dispatch pass reserves siblings in plan order.
- **Prewarm on trunk completion** — extend main-fabric prewarm hint to completed trunk jobs on the newest push (finish/plan/deps unblock) so a warm slot exists before the child webhook arrives.
- **Telemetry** — `hobo_ci_job_reserved` logs `queuedToReservedMs` from GitHub `created_at` to reservation time (complements `hobo_ci_job_pickup` `pickupMs`).

## Measure

Compare `queuedToReservedMs` and GitHub job `created_at` → `started_at` on consecutive green main Fabric pushes before/after deploy. Target: dependent jobs (deps layer, finish) under **15s** queue skew; workspace shard start spread within one poll/tick window on a capped fleet.

## Proof

- `packages/ci-gh-actions/test/admission-order.test.ts`
- `packages/ci-gh-actions/test/poll-ingest-coalesce.test.ts` (strand guard from finding 87)
- `packages/ci-gh-actions/test/hosted-runtime-duplicate-recheck.test.ts`
