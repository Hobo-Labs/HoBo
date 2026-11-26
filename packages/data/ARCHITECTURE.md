# @hobo/data — architecture

The CQRS fold kernel for HoBo's data plane (S1-15a). Design source:
[`docs/design/data-plane.md`](../../docs/design/data-plane.md) (Plan 11 + Plan 32).

## Two folds, one log

The append-only event log is the single source of truth. The same stream is
folded for two purposes:

- **Write-model fold — the aggregate.** A `command` runs inside an aggregate's
  single-writer boundary (an **actor** realized through the `ActorHost` lease +
  fencing token). It folds the stream to authoritative state, checks invariants,
  and emits past-tense **events** appended to the **event store** under optimistic
  `seq` **and** the lease `fenceToken` (storage `owner_epoch`). A concurrent
  append fails the optimistic check and raises a typed, retryable
  `AggregateConflictError`; a stale fence is distinct (`STALE_FENCE`); an illegal
  command raises a non-retryable `AggregateInvariantError`. `CommandEmitter`
  may `stageEffect()` durable queue/timer/outbox effects for the same
  `DurableEventStore.commit` transaction; `decide()` stays pure (no I/O). The
  aggregate emits `actor.*` lifecycle facts (Activated / StateAppended /
  Passivated). `createDurableActorHost` persists lease/fence state in the
  SQLite partition; `createInMemoryActorHost` remains the deterministic test
  default.
- **Read-model fold — the projection.** A projection is a deterministic,
  read-only fold producing **materialized views** (read models) keyed into rows.
  It is derived and **rebuildable from zero** (`rebuildFromZero()` replays the
  log — the test that the log, not the sink, is authoritative). **Snapshots** are
  a cache, never a source of truth, so the derived **read store** can be dropped
  and rebuilt at any time. The read fold is handed no write capability, so a
  projection can never mutate the write model.

## Schema evolution

Event bodies carry a version `v`. Readers apply chained, forward-only
**upcasters** (`vN -> vN+1`) on read; history is never rewritten. A body a
deterministic fold still cannot process is a **poison event**: the reader emits a
`*.Quarantined` fact recording the offending `seq`, so every replay skips it
deterministically instead of wedging the stream.

## Types

Records, messages, data, and objects are defined as protobuf in
[`data-models/data.proto`](./data-models/data.proto) with a CUE constraint per
type in [`data-models/data.cue`](./data-models/data.cue). The TypeScript surface
follows **parse, don't validate**: the exported interfaces are parsed, derived
domain types (branded ids, generics, richer fields) whose generated `*_pb.ts`
form is the wire encoding. The shared `EventEnvelope` is reused from
[`@hobo/core`](../core), never redefined here.

## Boundary

`@hobo/data` depends inward on `@hobo/core` and optionally
`@hobo/storage-sqlite` for the durable ActorHost adapter. The
`hobo:projection` provider port ([`src/port.ts`](./src/port.ts)) is the seam a
concrete sink adapter (native / relational / document) binds behind via
Matching. The PACT evidence in [`contracts/`](./contracts) pins the
event-store-append and projection-sink boundaries.
