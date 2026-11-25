# @hobo/data

The CQRS fold kernel for the HoBo data plane (S1-15a): `defineAggregate`
(write-model fold — command → invariant check → append under optimistic `seq`,
via an `ActorHost` single-writer lease + fencing) and `defineProjection`
(read-model fold — materialized views, `rebuildFromZero()`, snapshot cache).
Includes a forward-only upcaster registry and deterministic poison-event
quarantine.

Reuses the `EventEnvelope` and runtime ports from [`@hobo/core`](../core);
runs against the real `EventStore` (e.g. `@hobo/runtime-local`) rather than
reinventing a store. See [`ARCHITECTURE.md`](./ARCHITECTURE.md).

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
// result.seq is the client's reads-your-writes watermark.
```
