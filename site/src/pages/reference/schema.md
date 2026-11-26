---
layout: ../../layouts/Docs.astro
title: Schema & migrations
description: "SQLite user_version, streams/events/effects tables, codecs, legacy migration, and fail-closed integrity checks."
---

# Schema & migrations

Default durable journal schema lives in **SQLite storage engine**. Engines may differ physically; **semantics** (stream heads, positions, fencing, staged effects) must pass conformance.

## Versioning

| Constant | Meaning |
|---|---|
| `SCHEMA_VERSION` | Current (v2) |
| `LEGACY_SCHEMA_VERSION` | Prior on-disk (v1) |

`PRAGMA user_version` must match code. Opening a **newer** DB with older code → `UNSUPPORTED_SCHEMA_VERSION` (fail closed).

## Core tables (v2 conceptual)

| Table | Role |
|---|---|
| `streams` | Head row: stream id, revision, `owner_epoch`, metadata |
| `events` | Append-only bodies + per-stream `seq` + store `position` |
| `effects` / staged work | Queue, timer, outbox, signals pending dispatch |
| `subscriptions` / checkpoints | Durable consumer positions |
| `snapshots` | Optional fold caches (never source of truth) |

Exact SQL is owned by the storage engine; do not re-implement in apps.

## Native pragmas

Native single-owner partitions use WAL-friendly settings with **`synchronous=FULL`** (or equivalent durability) — throughput second to crash safety for the default path.

## Codecs

Event payloads encode via versioned codecs. Unknown codec → `UNSUPPORTED_CODEC`. Upcasters live in the data plane, not as silent rewrite of historical bytes without policy.

## Migration rules

1. Forward-only migrations; no destructive “fix by deleting the file” in production paths.
2. Legacy streams get `owner_epoch = 0` until first fenced write.
3. Integrity checks: contiguous seq, head matches last event, positions monotonic — failures → `STREAM_INTEGRITY` / `MIGRATION_FAILURE`.
4. Tests: [Migration fixtures](/HoBo/testing/migration/).

## What apps must not do

- Open the SQLite file and invent tables beside the journal.
- Use `COUNT(*)` as stream revision.
- Multi-writer mount the same file over NFS/SMB and call it HA.

## Related

[EventStore](/HoBo/reference/eventstore/) · [Durability testing](/HoBo/testing/durability/) · [WIT storage](/HoBo/reference/wit-storage/)
