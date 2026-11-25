# @hobo/events — architecture

The reactive-streams + saga-choreography kernel for HoBo's data plane (S1-15b).
Design source: [`docs/design/data-plane.md`](../../docs/design/data-plane.md)
(Plan 32).

## Reactivity — subscribe over the Streamer port

A **materialization** is a deterministic fold over subscribed **event** types,
exposed as a subscribable observable. The **Reactor** ([`src/reactor.ts`](./src/reactor.ts))
holds, per subscription, `{ materialization, readSet, lastSeq, state }`. On an
append to a stream in the read-set it recomputes the fold at the new monotonic
`seq`, and **pushes** the recomputed snapshot to the client over the
**`Streamer`** port. These are the same read models — **materialized views /
projections** — the `@hobo/data` write-model **command** / **actor** path feeds;
subscriptions are themselves a projection so they rebuild on Reactor failover,
and a snapshot of the folded value is only a cache (the log is authoritative, so
the derived **read store** can be dropped and rebuilt).

**Reads-your-writes.** A command returns its `seq` (from the aggregate over the
**event store**); a subscription's `awaitSeq(seq)` resolves only once the Reactor
has advanced to `>= seq`, so a client observes its own just-appended event before
acking. Monotonic `seq` means a client never regresses.

## Sagas — cross-aggregate choreography

Per-aggregate writes are serializable but cross-aggregate flows are **sagas**
([`src/saga.ts`](./src/saga.ts)), never a silent distributed transaction. On a
trigger fact the saga emits the next command into another aggregate; a step
failure runs **compensation** and records `saga.Compensated`. The saga emits
`saga.Started` / `saga.StepEmitted` / `saga.Compensated` / `saga.Completed`.

## Types

Records, messages, data, and objects are protobuf in
[`data-models/events.proto`](./data-models/events.proto) with a CUE constraint per
type in [`data-models/events.cue`](./data-models/events.cue). The TypeScript
surface follows **parse, don't validate**: exported interfaces are parsed,
derived domain types whose generated `*_pb.ts` form is the wire encoding. The
shared `EventEnvelope` is reused from [`@hobo/core`](../core).

## Boundary

`@hobo/events` depends inward on `@hobo/data` and `@hobo/core` only. The
`hobo:subscription/gateway` port ([`src/port.ts`](./src/port.ts)) is the transport
seam. PACT evidence in [`contracts/`](./contracts) pins the subscription-gateway
boundary.
