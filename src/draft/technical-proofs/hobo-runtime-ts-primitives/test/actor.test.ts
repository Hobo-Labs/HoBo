import assert from "node:assert/strict";
import { test } from "vitest";

import {
  actor,
  createInMemoryActorHost,
  createManualClock,
  getSharedActorHostForTests,
  resetActorHostForTests,
  signal,
} from "../src/index.js";

test("duplicate signal with same idempotency key applied once", async () => {
  resetActorHostForTests();
  const cart = actor("cart", {
    state: () => ({ items: 0 }),
    on: {
      AddItem: (state) => ({ items: state.items + 1 }),
    },
  });

  const key = cart.key("user-1");
  const msg = { type: "AddItem", payload: { sku: "abc" }, idempotencyKey: "add-abc" };
  await signal(key, msg);
  await signal(key, msg);

  const host = getSharedActorHostForTests();
  const lease = host.acquire("cart:user-1", { holderId: "reader" });
  const durable = host.state("cart:user-1", {
    initialState: { items: 0 },
    fold: (state, event) => {
      if (event.type === "AddItem") {
        return { items: state.items + 1 };
      }
      return state;
    },
  });
  const projection = await durable.read();
  assert.equal(projection.state.items, 1);
  await lease.release();
});

test("stale actor lease rejected before append", async () => {
  resetActorHostForTests();
  const manualClock = createManualClock();
  const host = createInMemoryActorHost({ clock: manualClock, leaseTtlMs: 30_000 });
  const leaseA = host.acquire("cart:stale", { holderId: "writer-a" });
  manualClock.advance(35_000);
  host.acquire("cart:stale", { holderId: "writer-b" });

  const durable = host.state("cart:stale", {
    initialState: { items: 0 },
    fold: (state, event) => event.payload ?? state,
  });

  await assert.rejects(
    async () => {
      await durable.append(leaseA, {
        type: "AddItem",
        payload: { items: 1 },
      });
    },
    /stale fence/i,
  );
});
