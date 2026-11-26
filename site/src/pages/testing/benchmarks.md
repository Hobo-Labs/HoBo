---
layout: ../../layouts/Docs.astro
title: Benchmarks
description: "Catch algorithmic regressions in journal, folds, and matching — seeds, medians, and what not to micro-optimize early."
---

# Benchmarks

Benchmarks catch **algorithmic** regressions (O(n²) folds, accidental full-table scans, lock convoys) — not vanity ops/sec on laptops.

## What to bench

| Area | Signal |
|---|---|
| Append + head CAS | Throughput under single writer |
| Fold large streams | Snapshot amortizes re-fold |
| `readAll` catch-up | Position scans stay linear |
| Matching toy plans | Placement solve stays bounded |
| Effect lattice helpers | Pure CPU; should be boring-fast |

## Rules

1. Deterministic seeds and fixed datasets.
2. Report medians with clear environment notes — not single-shot peaks.
3. Fail CI on large regressions only when baseline is pinned intentionally.
4. Do not bench network to public clouds in default gates.

## Related

[Property tests](/HoBo/testing/property/) · [EventStore](/HoBo/reference/eventstore/)
