---
layout: ../../layouts/Docs.astro
title: EventStore & journal
description: "DurableEventStore port, stream heads, fencing, positions, transactional effects, and the SQLite single-owner partition model."
---

# EventStore & journal

## Ports

| API | Role |
|---|---|
| `EventStore` | `append`, stream `read`, live `subscribe`, `snapshot` |
| `DurableEventStore` | + `readAll` (positioned), `commit` (events + effects), durable subscription checkpoints |

### Positioned events

```ts
type EventPosition = bigint; // branded / parse-don't-validate
interface PositionedEvent {
  position: EventPosition;
  event: EventEnvelope;
}
```

`position` is **database-local** within a partition. It is not the domain ULID and not per-stream `seq`.

### Append options

- `expectedSeq` — optimistic concurrency (CAS).
- `fenceToken?: bigint` — actor lease fence; full 64-bit, never coerced to unsafe JS numbers.

### Typed errors (stable codes)

`OPTIMISTIC_SEQUENCE_CONFLICT`, `STALE_FENCE`, `MISSING_FENCE`, `CHECKPOINT_REGRESSION`, `UNSUPPORTED_SCHEMA_VERSION`, `SNAPSHOT_AHEAD`, `PERSISTENCE_UNAVAILABLE`, `SQLITE_BUSY`, …

## Single-owner partition model

- One SQLite file (or equivalent partition) · one active writer.
- Scale by **adding partitions**, not multi-writer WAL over NFS/SMB.
- Native: WAL + `synchronous=FULL` (Node `node:sqlite` behind a storage worker).
- Browser: Worker + OPFS when available; fail-closed if durable required without OPFS.

## Stream heads

Revision and `owner_epoch` live on a **streams** head row. Append algorithm:

1. `BEGIN IMMEDIATE`
2. Ensure head; read revision + epoch
3. Resolve idempotency
4. Validate expectedSeq + fencing
5. Insert events (contiguous seq + positions)
6. Stage durable effects
7. CAS-update head
8. Commit → then live wake-ups

Legacy streams migrate with `owner_epoch = 0` (unfenced); first fenced append enters fenced mode permanently.

## Transactional effects

`commit` may stage: queue messages, actor signals, timers, cron mutations, outbox rows — **same transaction** as domain events. Network dispatch happens **outside** the transaction (at-least-once + idempotency).

## Delivery guarantees

| Guarantee | Claim |
|---|---|
| Per-stream OCC | Yes |
| Fenced single writer | Yes |
| At-least-once subscriptions/outbox | Yes |
| Exactly-once external delivery | **No** |

## Engines

SQLite storage engine · local runtime · browser runtime · WIT `hobo:storage@0.1.0`

## Related testing

[Durable EventStore tests](/HoBo/testing/durability/)
