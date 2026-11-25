---
layout: ../../layouts/Docs.astro
title: Testing overview
description: "How HoBo makes testing unfamiliar-but-powerful: contract-derived mocks, effect-aware isolation, durable EventStore tests, bridge modes, and offline deployment rehearsal."
---

# Testing overview

> *Trust the bindle, test the journey — without a cloud account until you want one.*

HoBo collapses a lot of “special testing tools” into one idea: **every boundary is typed and contract-backed**, so you can point it at a different **mode** (live, mock, replay, bridge, shadow, fault) without rewriting the app. The patterns below are deliberate product features, not ad-hoc test helpers.

## Mental model

| Idea | What it buys you |
|---|---|
| **Contracts bound shape** | Consumer-driven expectations; providers can grow without breaking consumers |
| **Boundary modes** | Same production code path, different routing (mock / live / replay / bridge / shadow / fault) |
| **EffectSpec** | Pure work isolates with zero infra; domain I/O drives automatic mocks |
| **ResilienceProfile** | Fault-injection guided by the contract; never retries policy denials or terminal failures |
| **Event log** | Replay-equals-live; inspection without re-running side effects |
| **SQLite journal** | Real durability semantics offline (CAS, fencing, atomic effects) |

## Layers (read in this order)

1. **[Unit tests & boundaries](/HoBo/testing/unit/)** — unit tests; boundaries auto-mock from contract examples.
2. **[Aggregates & CQRS](/HoBo/testing/aggregates/)** — pure decide, fenceToken, conflict vs invariant.
3. **[Contracts & PACT](/HoBo/testing/contracts/)** — consumer/provider executable contracts; subset matching.
4. **[Effect-aware isolation](/HoBo/testing/effects/)** — pure vs domain-effect harness modes.
5. **[Dual fixtures](/HoBo/testing/dual-fixtures/)** — pure path vs effect path from the same metadata.
6. **[Durable EventStore](/HoBo/testing/durability/)** — stream-head CAS, fencing, positions, restart.
7. **[Migration fixtures](/HoBo/testing/migration/)** — legacy schema → current, fail-closed integrity.
8. **[Queue, timer, outbox](/HoBo/testing/queue-outbox/)** — lease fences, once-after-restart timers.
9. **[Deployment rehearsal](/HoBo/testing/deployment/)** — `hobo plan`, local lane, Gatekeeper.
10. **[Bridge modes](/HoBo/testing/bridge-modes/)** — live/mock/bridge/replay/shadow/fault.
11. **[Chaos & availability](/HoBo/testing/chaos/)** — session faults, synthetics, shadow.
12. **[Property & model](/HoBo/testing/property/)** — journal ≡ reference model.
13. **[Behavior & Cucumber](/HoBo/testing/behavior/)** — Gherkin evidence, not live E2E.
14. **[Benchmarks](/HoBo/testing/benchmarks/)** — catch algorithmic regressions.
15. **[Conformance & golden](/HoBo/testing/conformance/)** — port suites + deploy golden gate.
16. **[Anti-patterns](/HoBo/testing/anti-patterns/)** — what not to do.

## What you should *not* do

- Hand-write long-lived mocks that drift from contracts — use contract examples / effect harness mocks.
- Treat `COUNT(*)` stream length or multi-writer shared SQLite as “the real” store — the product uses stream heads and single-owner partitions.
- Retry `policy.Decided` denials or terminal WIT failures in tests “to be resilient” — that is a **bug** in the product model.
- Run broad full-repo test sweeps to discover code — search first, then narrow package tests.

## Related

- [Architecture](/HoBo/architecture/) — EventStore default, package map.
- [The Bridge](/HoBo/troubleshooting/bridge/) — local/remote development on the same modes.
- [Reference: effects](/HoBo/reference/effects/) · [EventStore](/HoBo/reference/eventstore/) · [contracts](/HoBo/reference/contracts/)
