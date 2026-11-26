---
type: CI Performance Finding
title: "Finding 112: inbox drain stalls poll tick"
description: "A single tick spent 677s in synchronous inbox delivery, blocking job poll and deps reservation on main."
tags: [hobo, ci, performance, inbox, box-worker, main-gate]
---

# Finding 112: inbox drain stalls poll tick

## Evidence

On commit `d1e7921ca` (PR #1893) a box worker logged **`hobo_ci_isolated_worker_tick_slow`** with **678s** total and **677451ms** in **`deliveriesMs`**, with **832** `one or more inbox deliveries failed` lines. Slower ticks in the **160–290s** range preceded it. While that tick ran, job polling and admission did not advance; **main** run `43094500900` kept the **deps** layer queued **10+ minutes** despite only **~2.7 GiB** free memory and PSI full avg10 **7.57**.

## Cause

The isolated worker **`reconcileAndLaunch`** path called **`runtime.tick({ maxDeliveries: 10 })`** on the same timer as lease reconcile and dispatch. Inbox delivery had **no per-delivery timeout or per-pass budget**, and failures accumulated until the tick **threw**, keeping **`singleFlight`** wedged for minutes.

## Fix

- **`drainWebhookInbox`**: per-delivery timeout (**`HOBO_CI_INBOX_DELIVERY_TIMEOUT_MS`**, default **5s**), per-pass budget (**`HOBO_CI_INBOX_DRAIN_BUDGET_MS`**, default **30s**), **`failWebhook`** backoff instead of aborting the tick.
- **Pull workers**: admission **`tick({ maxDeliveries: 0 })`**; inbox drain on a separate **≤5s** timer via **`runtime.drainInbox()`**, with structured **`hobo_ci_inbox_delivery_*`** logs (delivery id, event, duration, reason — no secrets).
- **`hobo_ci_trunk_fleet_defer_decision`** from #1893 unchanged (still logged from **`HostedRelay`** on trunk defer evaluation).

## Measure

No **`tick_slow`** with **`deliveriesMs` > ~30s** on pull workers; **deps** reservation within **~30s** of queueing when slots are free; hung or poison deliveries do not block **`runJobPoll`**.
