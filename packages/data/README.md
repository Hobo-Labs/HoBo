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

Projection definitions may provide a `rowSchema` with its WIT record name and
fields, plus `indexHints` for consumers. The read-model name is derived from
the schema unless explicitly supplied, in which case it must match. Declaration
facts and snapshots retain this metadata; index hints do not create indexes.
Projection snapshots also report `streamSequences`, the highest sequence
observed in each source stream, including events outside the read set. The
scalar `seq` is the highest of those values, not a global journal position;
neither value proves that an arbitrary input contained every earlier event.

An aggregate command may stage durable effects with `emitter.stageEffect`.
The event store must support atomic commits; otherwise the command raises
`DurableEffectUnavailableError` before its events are appended. Successful
commands return the store's effect receipts in `result.effects`.

When an aggregate fold rejects an event, `execute` records an
`aggregate.QuarantineRecorded` fact before running the command, or immediately
after appending an event emitted by that command. The fact names the original
event and the affected aggregate fold; other folds can still process that event.
Replays of the same aggregate skip the recorded event even if its implementation
changes. `load` raises `UnpersistedQuarantineError` when it encounters an
unrecorded failure; execute a command to record it under the aggregate lease.

For projection rebuilds, `rebuildWithQuarantine` stores
`projection.QuarantineRecorded` facts in a separate stream. Pass the store,
stream ID, tenant, and actor for those records. Rebuilds reuse existing facts,
verify that each names the same source event, and return the quarantined records
with the resulting snapshot. Other projections continue to process the original
events. `rebuildFromZero` remains read-only and reports fold failures directly.
Malformed quarantine records stop the fold or rebuild; they are not ignored or
turned into another quarantine record.

`aggregate.inspectQuarantines(store, streamId)` and
`projection.inspectQuarantines(sourceEvents, quarantineRecords)` test recorded
events against the current fold using cloned state. A finding identifies an
event that needs an explicit reprocessing decision. Inspection appends no
events, and replay continues to skip the recorded event. The fold callbacks
run during inspection and must not perform side effects.

Aggregate and projection definitions may provide `classifyFailure(error, event)`
to return `"deterministic"` or `"transient"`. Transient failures are rethrown
without recording quarantine, so the caller can retry. Other fold failures are
treated as deterministic by default. If an aggregate fails while folding events
it just committed, inspect the stream before repeating the command; its events
and effects may already have been committed.

`readQuarantineReport` reads persisted aggregate, projection, and EventStore
quarantine facts from a durable event store for a tenant. Findings include the
source event, affected fold, reason, and quarantine record location. The report
has bounded scanning and includes `nextPosition` when another page remains;
pass that position back through `parseEventPosition` to continue. `complete`
describes the journal observed during the scan.

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

## Paginated event views

`createPaginatedEventView` stores row changes in a dedicated EventStore stream as
`data.Changed` facts. Supply the resource, stream, tenant, actor, and declared
string or number sort indexes. Rows contain `id`, `streamId`, `seq`, and the
indexed fields. Updates require a higher source sequence; deletes preserve a
tombstone sequence. Cursors encode the sort value and row ID, so inserts before
an issued cursor do not move later pages.

The view rebuilds its sorted indexes in memory from the event stream on open.
A page reflects the events read so far; separate page requests are not one
frozen database snapshot. `order(...).watch(...)` pushes changes in its current
key range, and `loadMore()` extends that range. Watches poll for changes from
other EventStore connections every 250 ms by default; configure
`pollIntervalMs` to change this. Await `drain()` to observe subscriber errors,
call `unsubscribe()` when a watch ends, and call `close()` on the view when it
is no longer needed.

## Durable projection rebuilds

`createProjectionRebuild` reads an ordered prefix from a durable EventStore and
materializes rows into sharded journals in a separate physical EventStore.
Provide a stable source ID, migration ID, projection and schema version, event
types, row key, row parser, and deterministic fold. The parser must produce
finite JSON rows and return the same representation when replaying a stored row.
For a nondeterministic projection, use `recorded-output` mode and list only the
recorded output event types.

Each `runBatch()` reads a bounded number of source events per shard. Row changes
and the corresponding source position commit together. Competing workers retry
on journal conflicts, and a new instance resumes from the committed positions.
An optional snapshot seeds all shards from a pinned source position; the seed is
persisted before shard initialization so an interrupted initialization can
resume. A seed is limited to one EventStore payload and 255 rows per shard. The
first time all shards catch up, the rebuild records `migration.PhaseApplied` in
the audit stream with that source position and the backfill strategy.

Use a source position captured from the relevant source stream as the barrier
for `cutover`. The cutover succeeds only after every shard reaches that position
and a source read finds no later events. It atomically records
`migration.CutOver` and `projection.SinkRebound` in the cutover stream. Source
and journal do not share a transaction: pause writes
through the cutover or ensure the projection continues consuming the tail.
Routing must read `activeSink()` to use the recorded sink. Events appended after
the barrier still require further `runBatch()` calls. A short batch reports the
prefix read at that time; it does not freeze concurrent writes. `read()`
reconstructs rows from the shard journals and returns each shard's position,
which may differ while catching up.
