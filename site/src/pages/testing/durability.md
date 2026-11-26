---
layout: ../../layouts/Docs.astro
title: Durable EventStore testing
description: "How to test the default SQLite EventStore: stream-head CAS, fencing, positions, atomic effects, migration, and restart — offline and package-scoped."
---

# Durable EventStore testing

The Camp **EventStore** defaults to SQLite behind ports. Tests should exercise the **real semantics**, not an idealized in-memory fake, whenever durability is the claim under test.

## What “default SQLite” means

| Rule | Test implication |
|---|---|
| One **partition** file, one active writer | Don’t test multi-writer shared NFS/WAL as supported |
| Stream **head** holds revision + `owner_epoch` | Assert CAS; no `COUNT(*)` for revision |
| **Fence tokens** reject stale holders | Correct `expectedSeq` + lower fence still fails |
| **`global_position`** is store-local | Positions for catch-up ≠ ULID order ≠ domain identity |
| Atomic **commit** of events + effects | Rollback leaves neither events nor queue/timer/outbox |
| Snapshots are **caches** | Cannot write snapshot ahead of stream head |

## Where it lives

Exercise durability through the Camp EventStore and your package tests — not a toy fake of the journal.


## Minimum durability matrix

1. Append + read stream; optimistic conflict on stale `expectedSeq`.
2. Multi-event batch atomicity (crash mid-append leaves whole batches only).
3. Idempotency key retry returns deduped without advancing head incorrectly.
4. Fence: stale token / missing token on fenced stream.
5. `readAll(after)` positioned catch-up; checkpoint monotonicity.
6. Commit events + queue/timer/outbox; failure rolls all back.
7. Migrate legacy schema fixtures; integrity_check; reopen is idempotent.
8. Close/reopen file (and Worker recreate when testing browser).

## In-memory QueueClockStore

Runtime-local still has an **explicit in-memory** queue/clock adapter for deterministic pure unit tests. That is **not** the production durability claim. When the durable path is configured, queue/timer/outbox stage through the journal.

## Browser policy in tests

- `allowTransient: true` → in-memory journal for semantic coverage in Node CI.
- Durable required + no OPFS → `PERSISTENCE_UNAVAILABLE` (must not claim OPFS success).

## Next

- [Reference: EventStore](/HoBo/reference/eventstore/)
- [Chaos & availability](/HoBo/testing/chaos/)
