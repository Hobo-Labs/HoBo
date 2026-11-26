import assert from "node:assert/strict";
import { test } from "vitest";

import { createGraphqlFacadeRuntime } from "../src/graphql-facade-runtime.js";

function orderEvents() {
  return [
    {
      type: "order.created",
      tenant: "acme",
      streamId: "acme/order:1",
      seq: 1,
      payload: { id: "order-1", total: 42, internalCost: 27 },
    },
    {
      type: "order.created",
      tenant: "globex",
      streamId: "globex/order:2",
      seq: 1,
      payload: { id: "order-2", total: 99, internalCost: 61 },
    },
  ];
}

function createRuntime({ now = () => 0 } = {}) {
  return createGraphqlFacadeRuntime({
    now,
    events: orderEvents(),
    materializations: [
      {
        name: "orders",
        queryField: "orders",
        subscriptionField: "ordersChanged",
        reactive: true,
        readSet: ["order.created"],
        consistency: { level: "bounded-staleness", maxAgeMs: 50 },
        allow: { internalCost: "orders:cost:read" },
        fold(events, { tenant }) {
          return events
            .filter((event) => event.type === "order.created" && event.tenant === tenant)
            .map((event) => ({
              tenant: event.tenant,
              id: event.payload.id,
              total: event.payload.total,
              internalCost: event.payload.internalCost,
            }));
        },
      },
      {
        name: "dailyRevenue",
        queryField: "dailyRevenue",
        subscriptionField: "dailyRevenueChanged",
        reactive: false,
        readSet: ["order.created"],
        consistency: { level: "eventual", maxAgeMs: 1_000 },
        fold(events, { tenant }) {
          const total = events
            .filter((event) => event.type === "order.created" && event.tenant === tenant)
            .reduce((sum, event) => sum + event.payload.total, 0);
          return [{ tenant, id: "today", total }];
        },
      },
      {
        name: "unsafeOrders",
        queryField: "unsafeOrders",
        reactive: true,
        readSet: ["order.created"],
        consistency: { level: "session", maxAgeMs: 0 },
        fold(events) {
          return events
            .filter((event) => event.type === "order.created")
            .map((event) => ({
              tenant: event.tenant,
              id: event.payload.id,
              total: event.payload.total,
          }));
        },
      },
      {
        name: "sessionOrders",
        queryField: "sessionOrders",
        reactive: true,
        readSet: ["order.created"],
        consistency: { level: "session" },
        fold(events, { tenant }) {
          return events
            .filter((event) => event.type === "order.created" && event.tenant === tenant)
            .map((event) => ({
              tenant: event.tenant,
              id: event.payload.id,
              total: event.payload.total,
            }));
        },
      },
    ],
  });
}

test("GraphQL query resolves through cached materialization snapshots without repeated re-folds", () => {
  const runtime = createRuntime();
  const query = "query { orders { id total } }";

  const first = runtime.query({ document: query, context: { tenant: "acme" } });
  const second = runtime.query({ document: query, context: { tenant: "acme" } });

  assert.deepEqual(first.value, [{ id: "order-1", total: 42 }]);
  assert.equal(first.source, "materialization-snapshot");
  assert.equal(first.cacheHit, false);
  assert.equal(second.cacheHit, true);
  assert.deepEqual(second.value, first.value);
  assert.equal(runtime.stats("orders").folds, 1);
});

test("GraphQL subscriptions deliver live pushes from the same observable materialization", () => {
  const runtime = createRuntime();
  const pushes = [];

  const unsubscribe = runtime.subscribe({
    document: "subscription { ordersChanged { id total } }",
    context: { tenant: "acme" },
    onPush: (payload) => pushes.push(payload),
  });

  runtime.appendEvent({
    type: "order.created",
    tenant: "acme",
    streamId: "acme/order:3",
    seq: 2,
    payload: { id: "order-3", total: 17, internalCost: 8 },
  });
  unsubscribe();
  runtime.appendEvent({
    type: "order.created",
    tenant: "acme",
    streamId: "acme/order:4",
    seq: 3,
    payload: { id: "order-4", total: 21, internalCost: 10 },
  });

  assert.deepEqual(pushes, [
    {
      source: "observable-materialization",
      materialization: "orders",
      fieldName: "ordersChanged",
      seq: { "acme/order:1": 1, "acme/order:3": 2 },
      value: [
        { id: "order-1", total: 42 },
        { id: "order-3", total: 17 },
      ],
    },
  ]);
});

test("subscriptions ignore read-set events from a different tenant", () => {
  const runtime = createRuntime();
  const pushes = [];

  const unsubscribe = runtime.subscribe({
    document: "subscription { ordersChanged { id total } }",
    context: { tenant: "acme" },
    onPush: (payload) => pushes.push(payload),
  });

  runtime.appendEvent({
    type: "order.created",
    tenant: "globex",
    streamId: "globex/order:5",
    seq: 2,
    payload: { id: "order-5", total: 55, internalCost: 40 },
  });
  unsubscribe();

  assert.deepEqual(pushes, []);
});

test("tenant and allow scopes fail closed at the GraphQL resolver boundary", () => {
  const runtime = createRuntime();

  assert.throws(
    () => runtime.query({ document: "query { orders { id total } }", context: {} }),
    /resolved tenant is required/,
  );

  assert.throws(
    () =>
      runtime.query({
        document: "query { orders { id internalCost } }",
        context: { tenant: "acme", scopes: [] },
      }),
    /missing scope orders:cost:read for field internalCost/,
  );
});

test("non-reactive sinks support one-shot query but reject GraphQL subscription wiring", () => {
  const runtime = createRuntime();

  assert.deepEqual(
    runtime.query({
      document: "query { dailyRevenue { id total } }",
      context: { tenant: "acme" },
    }).value,
    [{ id: "today", total: 42 }],
  );

  assert.throws(
    () =>
      runtime.subscribe({
        document: "subscription { dailyRevenueChanged { id total } }",
        context: { tenant: "acme" },
        onPush() {},
      }),
    /dailyRevenue is non-reactive/,
  );
});

test("stale cached snapshots beyond the consistency bound are refreshed", () => {
  let clock = 0;
  const runtime = createRuntime({ now: () => clock });
  const document = "query { orders { id total } }";

  runtime.query({ document, context: { tenant: "acme" } });
  clock = 60;
  const refreshed = runtime.query({ document, context: { tenant: "acme" } });

  assert.equal(refreshed.cacheHit, false);
  assert.equal(refreshed.refreshedBecause, "stale-snapshot");
  assert.equal(runtime.stats("orders").folds, 2);
});

test("session snapshots refresh when the materialization seq advances even inside one clock tick", () => {
  const runtime = createRuntime({ now: () => 0 });
  const document = "query { sessionOrders { id total } }";

  const first = runtime.query({ document, context: { tenant: "acme" } });
  runtime.appendEvent({
    type: "order.created",
    tenant: "acme",
    streamId: "acme/order:3",
    seq: 2,
    payload: { id: "order-3", total: 17, internalCost: 8 },
  });
  const refreshed = runtime.query({ document, context: { tenant: "acme" } });

  assert.equal(first.cacheHit, false);
  assert.equal(refreshed.cacheHit, false);
  assert.equal(refreshed.refreshedBecause, "snapshot-behind-log");
  assert.deepEqual(refreshed.seq, { "acme/order:1": 1, "acme/order:3": 2 });
  assert.deepEqual(refreshed.value, [
    { id: "order-1", total: 42 },
    { id: "order-3", total: 17 },
  ]);
  assert.equal(runtime.stats("sessionOrders").folds, 2);
});

test("cross-tenant resolver leaks are caught before returning a row", () => {
  const runtime = createRuntime();

  assert.throws(
    () =>
      runtime.query({
        document: "query { unsafeOrders { id tenant total } }",
        context: { tenant: "acme" },
      }),
    /cross-tenant leak detected/,
  );
});
