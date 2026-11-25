---
type: Architecture Decision Record
title: "SQLite is the default embedded EventStore/runtime journal behind HoBo ports"
description: "SQLite is the default engine, not the public portability boundary. One partition, one active writer."
tags: [hobo, design, adr, data-plane, sqlite]
---

# ADR-0135 — SQLite default EventStore / durable actor journal

**Status:** Accepted  
**Date:** 2026-07-27  
**Check date for external refs:** 2026-07-27

## Context

HoBo needs a durable default for Camp EventStore, actor fencing, queue/timer/outbox
staging, and projection catch-up that works on:

- local development and bare metal;
- Node.js hosts;
- Kubernetes / container single-writer volumes;
- cloud VMs / cloud containers;
- browser-hosted WASM (SQLite WASM + OPFS);
- WebAssembly Components (host-supplied storage capability);
- future managed/distributed adapters behind the **same** contracts.

SQLite is widely available and operationally simple for single-owner partitions,
but treating the SQLite file format or SQL dialect as the *public* architecture
boundary would couple apps and Components to one engine and encourage unsafe
multi-writer topologies (shared NFS/SMB + WAL).

## Decision

1. **SQLite is the default embedded engine**, implemented behind HoBo-owned ports:
   TypeScript `EventStore` / `DurableEventStore` in `@hobo/core`, Protobuf/CUE
   boundary records, and WIT `hobo:storage@0.1.0` for Component hosts.
2. **SQLite is not the public portability boundary.** Managed stores
   (Postgres, Cosmos, DynamoDB, FoundationDB, remote event-store services)
   remain replaceable adapters that implement the same contracts.
3. **Partition ownership:** one SQLite database per Camp or actor partition,
   exclusively owned by one active storage owner at a time. Scale by adding
   partitions, not by multi-writer access to one WAL file.
4. **Unsupported topology:** multiple hosts concurrently writing one WAL
   database over shared network filesystems (NFS/SMB). Kubernetes uses a single
   fenced owner + local or RWO volume.
5. **Native profile:** `node:sqlite` (`DatabaseSync`) behind a serialized
   storage Worker; default `journal_mode=WAL`, `synchronous=FULL`,
   `foreign_keys=ON`, bounded busy timeout.
6. **Browser profile:** SQLite WASM in a dedicated Worker; default single-owner
   OPFS mode prefers `opfs-sahpool`. Do not copy native WAL pragmas blindly.
   OPFS absence is explicit: durable-required → `PERSISTENCE_UNAVAILABLE`;
   optional transient memory when caller policy allows.
7. **Component profile:** guests import `hobo:storage` capabilities; no SQL,
   paths, or SQLite handles cross the membrane. Host binds tenant/lane.
8. **Database-local `global_position`** is distinct from domain
   `EventEnvelope.seq` and event ULID identity. Cursors for partitioned
   deployments are at least `(partitionId, position)`.
9. **Stream heads + fencing:** revision and `owner_epoch` live on a dedicated
   stream-head row (not `COUNT(*)`). Append CAS and fence checks run inside the
   same write transaction. Legacy streams migrate with `owner_epoch=0`
   (unfenced); first fenced append enters fenced mode permanently for that stream.
10. **Transactional durable commit:** domain events and staged effects
    (queue, actor signal, timer, cron, outbox) commit atomically. Network I/O
    (outbox dispatch, queue handlers) runs **outside** the SQLite transaction.
11. **Delivery guarantees (precise):**
    - per-stream optimistic concurrency (`expectedSeq`);
    - fenced single writer per stream (`fenceToken` / `owner_epoch`);
    - at-least-once durable subscriptions and outbox;
    - idempotent effects via keys;
    - **not** exactly-once delivery across external systems.
12. **Schema versioning:** `PRAGMA user_version` + ordered migrations in
    `@hobo/storage-sqlite`. Unsupported newer schema versions fail closed.
    Migration from runtime-local v1 preserves events, snapshots, and
    idempotency keys; noncontiguous streams fail with diagnostics.

## Consequences

- **(+)** One default path for local, Node, K8s single-writer, browser, and WIT
  host binding with shared semantics and conformance suites.
- **(+)** Clear operator guidance: partition location, RWO volumes, backup via
  SQLite backup/serialize/checkpoint (not copying a live main file without WAL).
- **(−)** Multi-writer distributed durability requires a different adapter, not
  “SQLite on NFS.”
- **(−)** Browser OPFS constraints differ from native WAL; tests must cover both.

## External references (summarized; checked 2026-07-27)

- SQLite WAL: concurrent readers + single writer; not a distributed multi-master
  store — https://www.sqlite.org/wal.html
- SQLite WASM persistence / OPFS VFS options —
  https://sqlite.org/wasm/doc/trunk/persistence.md
- `@sqlite.org/sqlite-wasm` npm distribution —
  https://www.npmjs.com/package/@sqlite.org/sqlite-wasm
- Node.js `node:sqlite` (DatabaseSync) — Node 22+ / 24 docs
- WebAssembly Component Model WIT —
  https://component-model.bytecodealliance.org/

## Package map

| Concern | Package |
|---|---|
| Ports, errors, positions, fences | `@hobo/core` |
| Schema, migrations, commit semantics | `@hobo/storage-sqlite` |
| Node adapter + storage worker | `@hobo/runtime-local` |
| Browser Worker + OPFS policy | `@hobo/runtime-browser` |
| Aggregate fence propagation | `@hobo/data` |
| WIT `hobo:storage@0.1.0` | `@hobo/wit` |
| Conformance | `@hobo/conformance` |
