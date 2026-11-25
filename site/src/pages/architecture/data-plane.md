---
layout: ../../layouts/Docs.astro
title: Data plane
description: "Event-sourced app and control data: commands → facts, aggregates as actors, projections, snapshots, Streamer split, and the default SQLite journal."
---

# Data plane

The data plane is where **facts live**. Control plane (Yard) decides infrastructure; data plane runs your app and the Camp’s durable runtime. If the Yard is down, camps keep serving — they just cannot re-place that day.

## Why event sourcing is the foundation

| Benefit | What you get |
|---|---|
| **Recovery** | Crash mid-deploy or mid-workflow → replay rebuilds exact state |
| **Audit** | Every infra change and credential issuance is an ordered fact |
| **Time-travel** | Reconstruct as-of; diff two points (`hobo inspect`) |
| **Determinism** | Durable workflows replay over cached step results |

## One log, two folds

| Fold | Purpose |
|---|---|
| **Write model (aggregate)** | Authoritative state for invariant checks inside a single-writer actor |
| **Read model (projection)** | Rebuildable views for queries, dashboards, reactive UI |

Both fold the **same append-only event log**. Snapshots are **caches**, never sources of truth. Snapshot ahead of head → hard error (`SNAPSHOT_AHEAD`).

## Commands → past-tense facts

1. Commands enter at a boundary (HTTP, MCP, workflow step) — they are **not** stored as events.
2. Aggregate `decide` runs pure business rules against folded state.
3. Aggregate `emit` past-tense facts.
4. Append uses **`expectedSeq`** (optimistic concurrency) and optional **`fenceToken`** (lease fencing).
5. Optional **`stageEffect`** stages queue/timer/outbox work for the same durable transaction.
6. After commit, live subscribers wake; network dispatch of staged work is at-least-once.

## Default durable store

Camp EventStore defaults to a **single-owner SQLite partition** behind ports:

| Property | Detail |
|---|---|
| Stream head | Revision + `owner_epoch` on a head row — not `COUNT(*)` |
| Positions | Database-local `bigint` for catch-up (`EventPosition`) |
| Checkpoints | Durable subscription positions |
| Atomic effects | Domain events + staged work in one commit |
| Scale model | Add partitions; not multi-writer NFS WAL |

Details: [EventStore reference](/HoBo/reference/eventstore/) · [Durability tests](/HoBo/testing/durability/).

## Reactivity

Default reads are **subscriptions** over materializations (**replay-then-live**). GraphQL facades and point lookups are escape hatches over the same models. Session consistency is the usual default; stronger/weaker levels are entity-configurable.

## Upcasters & quarantine

Event bodies evolve via forward-only upcasters. Poison events produce `*.Quarantined` facts so folds skip deterministically instead of wedging forever. Crypto-shred / erase rebuilds projections without rewriting history bytes in place.

## What is *not* the event log

| Data | Home |
|---|---|
| Streamer **frame bodies** | Streamer journal (tokens, logs, progressive UI) |
| Authoritative-external provider DBs | Explicit escape hatch with staleness labels |
| Blob/object payloads | Bucket resources — store refs in events |

## Multi-aggregate work

Cross-aggregate operations are **eventually consistent** by design. Use sagas/choreography (events library) and correlation ids — do not invent a distributed transaction across aggregate streams.

## Related

[Architecture](/HoBo/architecture/) · [Control plane](/HoBo/architecture/control-plane/) · [Aggregates testing](/HoBo/testing/aggregates/) · [Runtime ports](/HoBo/reference/runtime-ports/)
