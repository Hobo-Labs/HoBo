---
layout: ../../layouts/Docs.astro
title: Property & model tests
description: "Journal ≡ reference model, concurrency shrinking, fence monotonicity, and codec round-trips."
---

# Property & model tests

When unit examples are not enough, pin **invariants** across random schedules.

## High-value properties

| Property | Idea |
|---|---|
| Journal ≡ model | Random command sequences; store fold equals pure reference model |
| Fence monotonic | Epoch never decreases for a stream key |
| Positions monotonic | `readAll` positions strictly increase |
| OCC | Concurrent appends never both commit same seq |
| Codec round-trip | encode∘decode = id for supported codecs |
| Effect staging | Commit atomicity under crash injection |
| Idempotency | Keys collapse duplicates |

## Tooling notes

- Prefer deterministic seeds (resilience profiles already use them).
- Shrink failures to minimal command traces for humans/agents.
- Run property suites in package scope — not as default discovery diagnostics for unrelated changes.

## Related

[Durability](/HoBo/testing/durability/) · [Aggregates](/HoBo/testing/aggregates/) · [Benchmarks](/HoBo/testing/benchmarks/)
