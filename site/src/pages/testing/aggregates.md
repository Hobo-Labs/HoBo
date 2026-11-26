---
layout: ../../layouts/Docs.astro
title: Aggregates & CQRS
description: "Test pure decide, expectedSeq conflicts, fenceToken discipline, invariants vs concurrency, and projection rebuilds."
---

# Aggregates & CQRS

Aggregates are **single-writer actors**. Tests prove pure business rules and concurrency semantics without a cloud account.

## What to unit-test first

| Concern | Assert |
|---|---|
| Happy path decide | Given history + command → expected facts |
| Invariant reject | `AGGREGATE_INVARIANT` (or domain equivalent) — **not** retryable |
| OCC conflict | Stale `expectedSeq` → conflict; reload & retry succeeds |
| Fence | Stale/missing fence fails closed — **not** treated as OCC |
| Idempotency | Same key does not double-apply effects |
| Fold purity | Fold(events) has no I/O |

## Pattern

```text
history facts → fold state → decide(command) → facts
append(expectedSeq, fenceToken?) → store accepts/rejects
projection.fold(facts) → read model
```

Use in-memory EventStore + ActorHost for pure tests; use SQLite partition tests when proving durability (see [Durability](/HoBo/testing/durability/)).

## Multi-aggregate

Cross-aggregate workflows are eventually consistent. Test sagas with correlation ids and failure compensation — do not pretend distributed transactions exist.

## Anti-patterns

- Calling wall-clock inside pure decide
- Treating `STALE_FENCE` as “retry with same token”
- Asserting on projection without replaying from facts
- Sharing one aggregate stream across unbounded entity ids

## Related

[Data plane](/HoBo/architecture/data-plane/) · [ActorHost](/HoBo/reference/actor-host/) · [Unit tests](/HoBo/testing/unit/)
