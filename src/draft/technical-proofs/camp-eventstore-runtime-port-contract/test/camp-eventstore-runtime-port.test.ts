import assert from "node:assert/strict";
import { test } from "vitest";

import {
  OptimisticSequenceConflictError,
  createManualClock,
  createRuntimeLocalEventStore,
  runEventStoreConformance,
} from "../src/camp-eventstore-runtime-port.js";
import { isJsonString } from "../src/json.js";


test("runtime-local EventStore appends, reads, subscribes, and snapshots one stream", async () => {
  const clock = createManualClock("2026-06-26T00:00:00.000Z");
  const store = createRuntimeLocalEventStore({ clock });
  const pushed = [];
  const subscription = store.subscribe({ streamId: "run:checkout-1" }, (event) => {
    pushed.push(event);
  });

  const appended = await store.append(
    "run:checkout-1",
    [{ type: "run.Started", data: { workflow: "checkout" } }],
    {
      expectedSeq: 0,
      actor: { kind: "system", id: "runtime-local" },
      tenant: "tenant-a",
      correlationId: "run-1",
    },
  );

  assert.equal(appended.appended.length, 1);
  assert.deepEqual(await store.read("run:checkout-1"), [
    {
      id: "run:checkout-1:1:run.Started",
      streamId: "run:checkout-1",
      seq: 1,
      type: "run.Started",
      v: 1,
      ts: "2026-06-26T00:00:00.000Z",
      actor: { kind: "system", id: "runtime-local" },
      tenant: "tenant-a",
      causationId: undefined,
      correlationId: "run-1",
      data: { workflow: "checkout" },
      meta: {},
    },
  ]);
  assert.deepEqual(pushed.map((event) => event.seq), [1]);

  const snapshot = await store.snapshot("run:checkout-1", { status: "started" }, 1);

  assert.deepEqual(snapshot, {
    streamId: "run:checkout-1",
    seq: 1,
    state: { status: "started" },
    savedAt: "2026-06-26T00:00:00.000Z",
  });

  subscription.unsubscribe();
});

test("seq-conditional append rejects stale concurrent writers without losing the first event", async () => {
  const store = createRuntimeLocalEventStore({ clock: createManualClock() });
  const options = appendOptions();

  await store.append("order:1", [{ type: "order.Created", data: { total: 25 } }], {
    ...options,
    expectedSeq: 0,
  });

  await assert.rejects(
    () =>
      store.append("order:1", [{ type: "order.Discounted", data: { amount: 5 } }], {
        ...options,
        expectedSeq: 0,
      }),
    OptimisticSequenceConflictError,
  );

  assert.deepEqual(
    (await store.read("order:1")).map((event) => [event.seq, event.type]),
    [[1, "order.Created"]],
  );
});

test("idempotency-key dedup gives exactly-once effects and is scoped per stream", async () => {
  const store = createRuntimeLocalEventStore({ clock: createManualClock() });
  const first = await store.append("invoice:1", [invoiceCharged("charge-123", 100)], {
    ...appendOptions(),
    expectedSeq: 0,
  });

  const retry = await store.append("invoice:1", [invoiceCharged("charge-123", 100)], {
    ...appendOptions(),
    expectedSeq: 0,
  });
  const otherStream = await store.append("invoice:2", [invoiceCharged("charge-123", 100)], {
    ...appendOptions(),
    expectedSeq: 0,
  });

  assert.equal(first.appended.length, 1);
  assert.equal(retry.appended.length, 0);
  assert.deepEqual(retry.deduped.map((event) => event.id), ["invoice:1:1:invoice.Charged"]);
  assert.deepEqual((await store.read("invoice:1")).map((event) => event.seq), [1]);
  assert.deepEqual(otherStream.appended.map((event) => event.id), ["invoice:2:1:invoice.Charged"]);
});

test("idempotency-key dedup collapses duplicate keys inside one append batch", async () => {
  const store = createRuntimeLocalEventStore({ clock: createManualClock() });

  const result = await store.append(
    "invoice:batch-1",
    [invoiceCharged("charge-456", 100), invoiceCharged("charge-456", 100)],
    { ...appendOptions(), expectedSeq: 0 },
  );

  assert.deepEqual(result.appended.map((event) => event.seq), [1]);
  assert.deepEqual(result.deduped.map((event) => event.seq), [1]);
  assert.deepEqual((await store.read("invoice:batch-1")).map((event) => event.seq), [1]);
});

test("poison event quarantine lets deterministic folds skip malformed bodies and continue", async () => {
  const store = createRuntimeLocalEventStore({ clock: createManualClock() });

  await store.append(
    "ticket:1",
    [
      { type: "ticket.Opened", data: { title: "Login" } },
      { type: "ticket.Commented", data: { text: "first" } },
      { type: "ticket.Opened", data: { status: "missing-title" } },
      { type: "ticket.Commented", data: { text: "second" } },
    ],
    { ...appendOptions(), expectedSeq: 0 },
  );

  const folded = await store.fold("ticket:1", {
    initialState: { comments: 0, title: "" },
    handlers: {
      "ticket.Opened": (state, event) => {
        if (!isJsonString(event.data.title)) {
          throw new Error("ticket.Opened requires title");
        }
        return { ...state, title: event.data.title };
      },
      "ticket.Commented": (state) => ({ ...state, comments: state.comments + 1 }),
    },
  });

  assert.deepEqual(folded, {
    streamId: "ticket:1",
    seq: 5,
    state: { comments: 2, title: "Login" },
    quarantined: [
      {
        offendingSeq: 3,
        quarantineSeq: 5,
        type: "ticket.Quarantined",
        reason: "ticket.Opened requires title",
      },
    ],
  });
  assert.deepEqual(
    (await store.read("ticket:1")).map((event) => [event.seq, event.type, event.data.offendingSeq]),
    [
      [1, "ticket.Opened", undefined],
      [2, "ticket.Commented", undefined],
      [3, "ticket.Opened", undefined],
      [4, "ticket.Commented", undefined],
      [5, "ticket.Quarantined", 3],
    ],
  );
});

test("runtime-local passes the EventStore conformance subset", async () => {
  const report = await runEventStoreConformance(() =>
    createRuntimeLocalEventStore({ clock: createManualClock() }),
  );

  assert.deepEqual(report, {
    contract: "hobo.camp-eventstore-runtime-port/v1",
    backend: "runtime-local",
    assertions: {
      seqConditionalAppend: "pass",
      idempotencyKeyDedup: "pass",
      poisonEventQuarantine: "pass",
      idempotencyCollisionScopedPerStream: "pass",
    },
  });
});

function appendOptions(overrides = {}) {
  return {
    actor: { kind: "system", id: "runtime-local" },
    tenant: "tenant-a",
    ...overrides,
  };
}

function invoiceCharged(idempotencyKey, amount) {
  return {
    type: "invoice.Charged",
    data: { amount },
    meta: { idempotencyKey },
  };
}
