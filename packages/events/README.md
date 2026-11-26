# @hobo/events

The reactive-streams + saga kernel for the HoBo data plane (S1-15b): `emit` /
`subscribe` over the event log, a **Reactor** that folds materializations and
pushes recomputed snapshots over the `Streamer` port with reads-your-writes via
`seq`, and `defineSaga` for cross-aggregate choreography with compensation.

Builds on [`@hobo/data`](../data) (aggregates/commands) and
[`@hobo/core`](../core) (EventEnvelope, EventStore, Streamer ports). See
[`ARCHITECTURE.md`](./ARCHITECTURE.md).

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
await sub.awaitSeq(seq); // reads-your-writes: the just-placed order is now visible
```

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
