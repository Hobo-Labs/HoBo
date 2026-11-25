---
type: Reference
title: "Temporal — Technology Reference"
description: "Durable-execution platform (workflows as code, event-history replay, activities, signals/queries); the industry benchmark HoBo's durable runtime is measured against."
tags: [hobo, technologies]
---

# Temporal

> **Technology** · Durable-execution platform (from the Cadence lineage):
> workflows written as ordinary code whose state survives crashes via event
> history + deterministic replay. Sources: temporal.io/docs,
> github.com/temporalio. Factual surface quoted under fair use.

## What it is

Temporal persists every workflow decision as an **event history**; workers
re-execute workflow code deterministically against that history to recover
state after any failure ("durable execution"). Non-deterministic work lives in
**activities** (retried with policies), **signals/queries/updates** interact
with running workflows, timers and `sleep` are durable, and versioning/patching
manages long-running code changes. The server is OSS (MIT-ish licensing for
SDKs; server under its own license), with Temporal Cloud as the managed offer.

## Key features

- **Workflows-as-code with replay** — no state machines or DSLs; determinism
  constraints instead.
- **Activities with retry policies** — at-least-once side-effect execution
  with backoff/heartbeats.
- **Durable timers, signals, queries, child workflows, continue-as-new.**
- **History as the source of truth** — the same idea HoBo generalizes:
  append-only log + deterministic fold.

## Relevance to HoBo

**Analog / validates — measured against, not adopted.** HoBo's durable
`workflow`/`step` runtime ([sdk-api](../design/sdk-api.md#plan-02), Layer 4)
credits its *feel* to **Vercel Workflows** (vision.md §borrows), but Temporal
is the industry benchmark for the underlying mechanism, and HoBo's
event-sourced substrate ([data-plane](../design/data-plane.md#plan-11),
ADR-0135 durable SQLite journal) is the same replay-from-history idea applied
platform-wide — control plane included — rather than scoped to workflow
workers. Named as an analog across
[architecture](../design/architecture.md#plan-10),
[reliability](../design/reliability-observability-cost.md#plan-05), and
[generated-stack](../design/generated-stack.md#plan-23). Divergences kept
honest: HoBo has no separate workflow server — Camps run the runtime in-process
over the journal; determinism is enforced by the replay gate
(`packages/runtime/src/replay`, `packages/replay`) and the VirtualClock port
rather than SDK sandboxing; and cross-language reach comes from the WIT
membrane, not per-language SDK reimplementations. A Temporal *adapter* behind
the runtime port remains a possible future provider — the recurring HoBo
stance — but is not designed.

## Sources

- https://docs.temporal.io — concepts (durable execution, event history)
- https://github.com/temporalio/temporal — server
- https://temporal.io/blog — durable-execution background
