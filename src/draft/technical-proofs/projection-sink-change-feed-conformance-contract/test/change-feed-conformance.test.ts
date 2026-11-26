import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CHANGE_FEED_CAPABILITY,
  CONFORMANCE_SUITE,
  DATA_CHANGED_EVENT_TYPE,
  assertLiveView,
  dataChanged,
  declareProjectionContract,
  doctorLiveView,
  projectionSink,
  readSnapshot,
  runOrderedFeedConformance,
} from "../src/change-feed-conformance.js";

test("change-feed projection sink passes ordered data.Changed conformance", () => {
  const sink = projectionSink({
    kind: "postgres-logical-replication",
    paradigm: "relational",
    capabilities: ["query", CHANGE_FEED_CAPABILITY],
  });
  const projection = declareProjectionContract({
    name: "Tickets",
    readModel: "support:tickets/ticket-view@1.0.0",
    readSet: ["ticket.Opened", "ticket.Renamed", "ticket.Deleted"],
    sink,
  });

  const result = runOrderedFeedConformance({
    sink,
    expectedChanges: ticketLifecycle(),
    observedEvents: ticketLifecycleEvents(),
  });

  assert.equal(projection.reactive, true);
  assert.equal(projection.projectionDeclared.data.reusedEventFamily, DATA_CHANGED_EVENT_TYPE);
  assert.deepEqual(result, {
    ok: true,
    suite: CONFORMANCE_SUITE,
    sink,
    observed: 3,
    expected: 3,
    failures: [],
  });
});

test("sink without change-feed is non-reactive and warns only on live view", () => {
  const sink = projectionSink({
    kind: "warehouse-batch",
    paradigm: "olap",
    capabilities: ["analytics", "batch"],
  });
  const projection = declareProjectionContract({
    name: "DailyRevenue",
    readModel: "finance:revenue/daily@1.0.0",
    readSet: ["invoice.Paid"],
    sink,
  });

  assert.equal(projection.reactive, false);
  assert.equal(projection.reactivityClass, "non-reactive");
  assert.equal(projection.projectionDeclared.data.reactivity.source, "no-change-feed");
  assert.deepEqual(doctorLiveView(projection), [
    {
      code: "non-reactive-live-view",
      severity: "warning",
      projection: "DailyRevenue",
      message:
        '"use query" depends on a non-change-feed projection sink; use snapshot/repo reads or select a native/change-feed sink for live updates.',
    },
  ]);
  assert.deepEqual(readSnapshot(projection, [{ day: "2026-06-26", revenue: 42 }], { seq: 12 }), {
    mode: "snapshot",
    projection: "DailyRevenue",
    reactive: false,
    seq: 12,
    rows: [{ day: "2026-06-26", revenue: 42 }],
  });
});

test("non-relational projection sink can advertise change-feed and be reactive", () => {
  const sink = projectionSink({
    kind: "dynamodb-streams",
    paradigm: "kv",
    capabilities: ["query", CHANGE_FEED_CAPABILITY],
  });
  const projection = declareProjectionContract({
    name: "SessionIndex",
    readModel: "identity:sessions/session-index@1.0.0",
    readSet: ["session.Started", "session.Revoked"],
    sink,
  });

  assert.equal(projection.reactive, true);
  assert.equal(projection.projectionDeclared.data.reactivity.source, "sink-change-feed");
  assert.deepEqual(doctorLiveView(projection), []);
  assert.equal(
    runOrderedFeedConformance({
      sink,
      expectedChanges: ticketLifecycle(),
      observedEvents: ticketLifecycleEvents(),
    }).ok,
    true,
  );
});

test("out-of-order data.Changed feed fails conformance", () => {
  const result = runOrderedFeedConformance({
    sink: changeFeedSink(),
    expectedChanges: ticketLifecycle(),
    observedEvents: [
      dataChanged({ resource: "tickets", key: "ticket-1", op: "insert", seq: 1 }),
      dataChanged({ resource: "tickets", key: "ticket-1", op: "delete", seq: 3 }),
      dataChanged({ resource: "tickets", key: "ticket-1", op: "update", seq: 2 }),
    ],
  });

  assert.equal(result.ok, false);
  assert.deepEqual(
    result.failures.map((failure) => failure.code),
    ["unexpected-change-order", "unexpected-change-order", "out-of-order-seq"],
  );
});

test("dropping delete from a change-feed fails conformance", () => {
  const result = runOrderedFeedConformance({
    sink: changeFeedSink(),
    expectedChanges: ticketLifecycle(),
    observedEvents: [
      dataChanged({ resource: "tickets", key: "ticket-1", op: "insert", seq: 1 }),
      dataChanged({ resource: "tickets", key: "ticket-1", op: "update", seq: 2 }),
    ],
  });

  assert.equal(result.ok, false);
  assert.equal(result.failures[0].code, "missing-change");
  assert.match(result.failures[0].message, /delete/);
});

test("double-emitting one sink operation fails conformance", () => {
  const result = runOrderedFeedConformance({
    sink: changeFeedSink(),
    expectedChanges: ticketLifecycle(),
    observedEvents: [
      dataChanged({ resource: "tickets", key: "ticket-1", op: "insert", seq: 1 }),
      dataChanged({ resource: "tickets", key: "ticket-1", op: "update", seq: 2 }),
      dataChanged({ resource: "tickets", key: "ticket-1", op: "update", seq: 3 }),
      dataChanged({ resource: "tickets", key: "ticket-1", op: "delete", seq: 4 }),
    ],
  });

  assert.equal(result.ok, false);
  assert(result.failures.some((failure) => failure.code === "double-emitted-change"));
});

test("live view assertion fails closed for non-reactive sinks", () => {
  const projection = declareProjectionContract({
    name: "RevenueCube",
    readModel: "finance:revenue/cube@1.0.0",
    readSet: ["invoice.Paid"],
    sink: projectionSink({
      kind: "object-lake",
      paradigm: "object-lake",
      capabilities: ["batch"],
    }),
  });

  assert.throws(() => assertLiveView(projection), /not reactive/);
});

function ticketLifecycle() {
  return [
    { resource: "tickets", key: "ticket-1", op: "insert" },
    { resource: "tickets", key: "ticket-1", op: "update" },
    { resource: "tickets", key: "ticket-1", op: "delete" },
  ];
}

function ticketLifecycleEvents() {
  return [
    dataChanged({ resource: "tickets", key: "ticket-1", op: "insert", seq: 1 }),
    dataChanged({ resource: "tickets", key: "ticket-1", op: "update", seq: 2 }),
    dataChanged({ resource: "tickets", key: "ticket-1", op: "delete", seq: 3 }),
  ];
}

function changeFeedSink() {
  return projectionSink({
    kind: "mongo-change-streams",
    paradigm: "document",
    capabilities: ["query", CHANGE_FEED_CAPABILITY],
  });
}
