---
layout: ../../layouts/Docs.astro
title: Queue, timer, outbox
description: "Lease fences, idempotent consumers, transactional staging with EventStore, and once-after-restart timers."
---

# Queue, timer, outbox

Deferred work is where “it worked on my machine” goes to die. Prove lease and restart semantics explicitly.

## Must-pass cases

| Case | Assert |
|---|---|
| Enqueue + lease + complete | Happy path |
| Lease expiry + re-lease | Previous complete fails closed (stale fence) |
| Idempotent consumer | Duplicate delivery → one external effect |
| Stage in commit | Crash after commit still delivers at-least-once |
| Crash before commit | No phantom dispatch |
| Timer once-after-restart | Deadline fires once; no double-fire |
| Cron/schedule | Deterministic with virtual Clock |

## Transactional staging

Domain events + staged queue/timer/outbox rows commit atomically. Network I/O is **after** commit. Tests should kill the process in both windows.

## Clock

Use virtual Clock — wall sleeps make CI flaky and hide bugs.

## Related

[Queue port](/HoBo/reference/queue/) · [Clock](/HoBo/reference/clock/) · [EventStore](/HoBo/reference/eventstore/) · [Durability](/HoBo/testing/durability/)
