---
layout: ../../layouts/Docs.astro
title: Clock port
description: "Deterministic virtual Clock for workflows, timers, cron, and replay — wall-clock never sneaks into pure folds."
---

# Clock port

The **Clock** port supplies time and sleep/cron primitives so workflows and tests can be **deterministic**. Wall-clock `Date.now()` inside pure decide/fold paths is a bug.

## Responsibilities

| API family | Role |
|---|---|
| `now` | Current instant in the active clock domain |
| `sleep` / delay | Schedule wake-ups (pairs with timer journal) |
| `cron` / schedule | Recurring triggers as durable facts + wakes |
| Advance (test) | Virtual clocks jump without waiting real time |

## Why it exists

- **Replay** of workflows must re-enter the same branches.
- **Timers** staged in the journal must fire once-after-restart with the same deadlines.
- **Property tests** need controlled time to explore schedules without flakiness.

## Rules

1. Aggregates that need “business time” take it as a **command field** or injected clock reading at the boundary — not ad-hoc OS time inside pure functions.
2. Event envelope timestamps are assigned at append by the store/runtime — folds treat them as data.
3. Resilience timeouts use the same clock domain as the runtime so virtual tests remain meaningful.
4. Never sleep with real wall timers inside pure unit tests of domain logic.

## Coupling

- Durable timers may stage beside events in `DurableEventStore.commit`.
- ActorHost leases may use clock for expiry.
- Streamer and logs may show wall time for humans; domain correctness does not depend on it.

## Related

[Runtime ports](/HoBo/reference/runtime-ports/) · [Queue](/HoBo/reference/queue/) · [Aggregates testing](/HoBo/testing/aggregates/)
