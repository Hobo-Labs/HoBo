---
layout: ../../layouts/Docs.astro
title: ActorHost & fencing
description: "Single-writer AggregateLease, monotonic fenceToken, lease conflicts, and how fencing couples to EventStore append/commit."
---

# ActorHost & fencing

**ActorHost** is the Camp port that hands out **single-writer leases** for aggregates (and similar actors). Without it, optimistic concurrency alone cannot stop a zombie process from appending with a stale view of the world after a steal.

## AggregateLease

A lease (conceptual shape):

| Field | Role |
|---|---|
| Aggregate / actor key | Who is leased |
| `holderId` | Process or worker identity |
| `fenceToken` | Monotonic **bigint** epoch for this key |
| Expiry | Optional lease deadline |

In-memory hosts exist for tests; production Camps use durable hosts that persist epoch across restarts, backed by the journal.

## Dual placement (native · dapr)

The same actor definitions run under either host:

| Mode | When | Notes |
|---|---|---|
| **native** (default) | No Camp dapr requirement | Lease + fence on local / wasm hosts |

Prefer native unless you need the sidecar path. See [Messaging, Kafka & Dapr](/HoBo/reference/messaging/).

## Append algorithm coupling

When an aggregate is fenced:

1. Acquire/renew lease → receive `fenceToken`.
2. `decide` pure business rules in memory.
3. `append` / `commit` with `expectedSeq` **and** `fenceToken`.
4. Store compares token to stream head `owner_epoch`:
 - equal → accept (and may bump epoch per engine rules)
 - lower → `STALE_FENCE`
 - missing on fenced stream → `MISSING_FENCE`

Legacy streams start with `owner_epoch = 0` (unfenced). First fenced append enters fenced mode permanently.

## Error policy

| Code | Meaning | Aggregate retry? |
|---|---|---|
| `AGGREGATE_CONFLICT` / OCC | Stale expectedSeq | Yes — reload & retry |
| `STALE_FENCE` | Lost lease | **No** as blind OCC retry |
| `AGGREGATE_INVARIANT` | Business reject | No |

## Rules

- Never coerce `fenceToken` through `Number` — full 64-bit.
- Lease steal must advance epoch so the previous holder fails closed.
- Passivate emits facts; do not rely on process memory for “I still own it.”

## Related

[EventStore](/HoBo/reference/eventstore/) · [Messaging, Kafka & Dapr](/HoBo/reference/messaging/) · [Aggregates testing](/HoBo/testing/aggregates/) · [Durability testing](/HoBo/testing/durability/)
