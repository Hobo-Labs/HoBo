---
layout: ../../layouts/Docs.astro
title: Queue port
description: "Camp Queue: enqueue, lease, complete, idempotency, actor signals, and transactional staging with the EventStore journal."
---

# Queue port

The **Queue** is the Camp port for deferred and concurrent work: jobs, actor signals, delayed delivery, and outbox-style dispatch. Ports are product surfaces; engines implement lease semantics.

## Operations (conceptual)

| Op | Role |
|---|---|
| `enqueue` | Persist a message with optional delay, group, and idempotency key |
| `lease` | Claim work for a worker with visibility timeout + fence |
| `complete` / `fail` | Ack success or schedule retry / DLQ path |
| `signal` mapping | Deliver actor wake-ups without inventing a second bus |

## Guarantees

| Guarantee | Claim |
|---|---|
| At-least-once delivery | **Yes** |
| Exactly-once external side effects | **No** — use idempotency keys |
| Ordered per group/key (engine-dependent) | When configured |
| Survives process restart | When backed by durable journal |

## Transactional staging

When using **DurableEventStore.commit**, queue messages (and timers/outbox rows) may stage in the **same transaction** as domain events. Network dispatch happens **outside** the transaction. That yields:

- Domain fact + “work is pending” atomicity
- At-least-once dispatch after commit
- Need for consumer idempotency

## Leases and fencing

Workers hold leases. Completing work after a stolen lease must fail closed (stale fence). Same fence discipline as ActorHost / EventStore — do not coerce fence tokens to unsafe JS numbers.

## Testing

- Restart with staged messages still leased correctly.
- Double-complete after lease expiry fails closed.
- See [Queue, timer, outbox](/HoBo/testing/queue-outbox/).

## Related

[Messaging, Kafka & Dapr](/HoBo/reference/messaging/) · [EventStore](/HoBo/reference/eventstore/) · [ActorHost](/HoBo/reference/actor-host/) · [Runtime ports](/HoBo/reference/runtime-ports/)
