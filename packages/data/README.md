# @hobo/data

The CQRS fold kernel for the HoBo data plane (S1-15a): `defineAggregate`
(write-model fold — command → invariant check → append under optimistic `seq`,
via an `ActorHost` single-writer lease + fencing) and `defineProjection`
(read-model fold — materialized views, `rebuildFromZero()`, snapshot cache).
Includes a forward-only upcaster registry and deterministic poison-event
quarantine.

An upcaster chain must contain every transition needed by an event. Missing
transitions raise `UpcasterChainError` before a fold or aggregate append; they
are configuration failures and do not quarantine the event. Registration order
does not matter, and a chain can be completed before it is used.

Reuses the `EventEnvelope` and runtime ports from [`@hobo/core`](../core);
runs against the real `EventStore` (e.g. `@hobo/runtime-local`) rather than
reinventing a store.

```ts
import { defineAggregate, defineProjection, createInMemoryActorHost } from "@hobo/data";

const orders = defineAggregate({
  name: "order",
  initialState: { placed: false },
  evolve: (s, e) => (e.type === "order.Placed" ? { ...s, placed: true } : s),
  decide: (state, cmd, emit) => {
    if (state.placed) throw new Error("already placed");
    emit.emit("order.Placed", { orderId: cmd.id, totalCents: cmd.totalCents });
  },
});

const result = await orders.execute(
  { store, actorHost: createInMemoryActorHost() },
  "order:1001",
  { id: "1001", totalCents: 4200 },
  { tenant: "t-a", actor: { kind: "user", id: "u1" } },
);
```

`result.seq` is the client's reads-your-writes watermark.

When an aggregate fold rejects an event, `execute` records an
`aggregate.QuarantineRecorded` fact before running the command. The fact names
the original event and the affected aggregate fold; other folds can still
process that event. Replays of the same aggregate skip the recorded event even
if its implementation changes. `load` raises `UnpersistedQuarantineError` when
it encounters an unrecorded failure; execute a command to record it under the
aggregate lease.

For projection rebuilds, `rebuildWithQuarantine` stores
`projection.QuarantineRecorded` facts in a separate stream. Pass the store,
stream ID, tenant, and actor for those records. Rebuilds reuse existing facts,
verify that each names the same source event, and return the quarantined records
with the resulting snapshot. Other projections continue to process the original
events. `rebuildFromZero` remains read-only and reports fold failures directly.

`createCrossCampProjection` copies an owner's ordered event stream into an
independent replica event store and folds the copied events with the same
projection. It can read all streams for a tenant or a named source stream.
Calls to `append` from either Camp write to the owner. Call `replicate` until
it reports `caughtUp`, and call it again on the application's polling schedule.
Each batch and its checkpoint are appended atomically; competing replicators
retry on sequence conflicts. A new instance can resume from the replica log.

Replica reads and subscriptions include the age of the last completed owner
read. A partial batch does not advance that time, and a replica with no
completed read reports `unknown`. The age is measured from the start of the
owner read with the supplied clock. This bound depends on the owner store's
`readAll` returning a complete, ordered prefix; it does not account for any
staleness inside that store. Configure `onLag` to record or publish the emitted
`projection.ReplicaLagged` input when a read exceeds the bound. Reads are required to
detect lag while replication is idle.
