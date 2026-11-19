---
layout: ../../layouts/Docs.astro
title: Journal schema
description: "SQLite journal initialization, tables, codecs, and integrity checks."
---

# Journal schema

Default durable journal schema lives in **SQLite storage engine**. Engines may differ physically; **semantics** (stream heads, positions, fencing, staged effects) must pass conformance.

## Versioning

| Constant | Meaning |
|---|---|
| `SCHEMA_VERSION` | Current journal schema format |

`PRAGMA user_version` must match the journal's schema. A mismatched version is
rejected with `UNSUPPORTED_SCHEMA_VERSION`. An unstamped database containing
objects or a database with altered journal tables or indexes is rejected.

## Core tables

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

Event payloads encode via codecs. Unknown codec → `UNSUPPORTED_CODEC`.

## Initialization

The journal creates its schema in one transaction. Reopening verifies the
stored table and index definitions. Incompatible databases are left intact.
`assertIntegrity` checks SQLite integrity and foreign keys.

## What apps must not do

- Open the SQLite file and invent tables beside the journal.
- Use `COUNT(*)` as stream revision.
- Multi-writer mount the same file over NFS/SMB and call it HA.

## Related

[EventStore](/HoBo/reference/eventstore/) · [Durability testing](/HoBo/testing/durability/) · [WIT storage](/HoBo/reference/wit-storage/)
