---
layout: ../../layouts/Docs.astro
title: Runtime ports
description: "Camp durable ports: EventStore, DurableEventStore, Queue, Streamer, ActorHost, Clock — coupling rules and default SQLite engine."
---

# Runtime ports

A **Camp** provides the durable substrate app runtimes need. **Ports** are product surfaces; **engines** implement them (SQLite storage engine, local runtime, browser runtime, future Postgres/Temporal/… adapters).

## Port table

| Port | Responsibility | Default notes |
|---|---|---|
| **EventStore** | Append-only facts, stream read, live subscribe, snapshots | OCC via `expectedSeq` |
| **DurableEventStore** | + positions, `commit` with staged effects, durable checkpoints | SQLite partition |
| **Queue** | Enqueue / lease / complete; actor signal mapping | At-least-once |
| **Streamer** | High-volume frames **outside** domain log | Replay-then-live `fromSeq` |
| **ActorHost** | Single-writer lease + monotonic `fenceToken` | Fence couples to append |
| **Clock** | Deterministic time + sleep/cron for replay | Virtual in tests |

## Coupling rules

1. Aggregates acquire **ActorHost** leases and pass **fenceToken** into EventStore `append` / `commit`.
2. Queue / timer / outbox may **stage inside** the journal transaction when durability is configured; network I/O happens after commit.
3. Streamer frame bodies are **not** domain events unless an audit policy opts in.
4. Clock reads during replay must not inject wall-clock nondeterminism into pure folds.
5. Yard control plane is **not** on the Camp data path for live user requests.

## Default engine

| Engine | Role |
|---|---|
| SQLite storage | Schema, migrations, journal semantics |
| Local runtime | Node EventStore + storage worker |
| Browser runtime | SQLite WASM + OPFS policy (fail-closed if durable required) |
| `hobo:storage@0.1.0` | Component-host storage capability |

Scale by **adding partitions** (single active writer each), not multi-writer WAL over shared network filesystems.

## Port descriptors

Port descriptors carry WIT-style interface refs and stability (`stable` | `preview` | `experimental`). Apps depend on ports; engines stay swappable behind conformance.

## Testing

| Concern | Page |
|---|---|
| CAS, fencing, restart | [Durable EventStore](/HoBo/testing/durability/) |
| Pure decide + conflicts | [Aggregates](/HoBo/testing/aggregates/) |
| Queue/timer/outbox | [Queue, timer, outbox](/HoBo/testing/queue-outbox/) |
| Engine swap | [Conformance](/HoBo/testing/conformance/) |

## Related

[EventStore](/HoBo/reference/eventstore/) · [Queue](/HoBo/reference/queue/) · [Streamer](/HoBo/reference/streamer/) · [ActorHost](/HoBo/reference/actor-host/) · [Clock](/HoBo/reference/clock/)
