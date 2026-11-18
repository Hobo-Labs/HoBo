# @hobo/events

The reactive-streams + saga kernel for the HoBo data plane (S1-15b): `emit` /
`subscribe` over the event log, a **Reactor** that folds materializations and
pushes recomputed snapshots over the `Streamer` port with reads-your-writes via
per-stream positions, and `defineSaga` for cross-aggregate choreography with compensation.

Builds on [`@hobo/data`](../data) (aggregates/commands) and
[`@hobo/core`](../core) (EventEnvelope, EventStore, Streamer ports).

```ts
import { createReactor, defineMaterialization, defineSaga } from "@hobo/events";

const openOrders = defineMaterialization({
  name: "openOrders",
  readSet: ["order.Placed"],
  initialState: [] as { orderId: string }[],
  fold: (state, e) =>
    e.type === "order.Placed" ? [...state, { orderId: e.data.orderId }] : state,
});

const reactor = createReactor({ store, streamer });
const sub = await reactor.subscribe(openOrders, { subscriptionId: "sub:orders" });
const { seq } = await orders.execute(deps, "order:1", cmd, ctx);
await sub.awaitStreamSeq("order:1", seq);
```

`replayStreamId` rebuilds one stream before live events are applied. The Reactor
buffers events while replay runs and ignores events already folded from that
stream. Other streams are observed from the live subscription's readiness point;
they are not reconstructed by this option. `awaitStreamSeq` waits for a specific
stream, including events outside the read set. The legacy `awaitSeq` reports the
largest sequence seen in the read set and cannot establish progress for a
particular stream.

Each pushed frame includes `streamSeqs`. A slow reader leaves at most one latest
snapshot pending while the Reactor retries backpressure; it receives the latest
state and stream positions when it resumes.

`createOptimisticSubscription` accepts those frames and overlays pending command
patches on a copy of the authoritative value. Pass each command's expected
stream positions as `seqFloor`; a frame that reaches every position reconciles
the patch. Rejecting a command removes its patch and reapplies the remaining
ones. Patches whose sequence floors are ordered run in that order; otherwise the
earliest submitted eligible patch runs first. Patch functions must be deterministic and
free of side effects because they can run again after each frame or rejection.
The visible `seq` and `streamSeqs` always come from the authoritative frame.
The subscription rejects regressing frames and keeps its previous state if a
patch throws while a change is being evaluated. Its audit log is in memory.

`maxBufferedEvents` and `maxTrackedStreams` each default to 10,000. Exceeding a
limit closes the subscription and rejects pending waits. Closing a subscription
also rejects pending waits; a failed initial listener or replay cleans up the
subscription and its Streamer run.

## Pinned event bodies

`MIGRATION_EVENT_CONTRACTS` (`src/upcaster-corpus.ts`) pins the wire bodies of
the `migration.*` family, one evolution contract per type, and
`corpus/golden-replay-baseline.json` is the append-only record of every body
ever pinned. `runCanDeployUpcasterGate` replays each pinned body through its
upcaster chain to the current version; a body that cannot be lifted fails the
test lane.

A body schema is a list of tagged fields: `stringField`, `u32Field`,
`boolField`, `stringsField` (a list of strings) and `jsonField` (a JSON object,
carried as its canonical text).

Two kinds of change, and they are not interchangeable:

- **An optional field on the current version** — when every body that was
  valid stays valid and nothing changes meaning.
- **A new version with an upcaster and a new pinned body** — when a required
  field stops being required, a field changes type, or a field is withdrawn.
  The baseline only ever gains entries; `migrationCorpusBaseline()` and
  `pricingCorpusBaseline()` are what it is regenerated from.

`test/migration-fact-contracts.test.ts` runs every `@hobo/data-core` executor
against the reference engine, journals the facts on the real event store, and
validates each one against the current version of its contract — so an
emitter and its pinned body cannot drift apart.
