import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONSISTENCY_LEVELS,
  PROJECTION_DECLARED_EVENT_TYPE,
  assessConsistencyTradeoffs,
  declareProjection,
  doctorUseQuery,
  projectionSink,
} from "../src/projection-contract.js";

test("projection contract exposes tunable consistency and defaults to session", () => {
  const projection = declareProjection({
    name: "OpenTickets",
    readModel: "TicketList",
    eventTypes: ["Ticket.Opened", "Ticket.Assigned", "Ticket.Closed"],
  });

  assert.deepEqual(CONSISTENCY_LEVELS, [
    "strong",
    "bounded-staleness",
    "session",
    "consistent-prefix",
    "eventual",
  ]);
  assert.equal(projection.consistency, "session");
  assert.equal(projection.projectionDeclared.payload.consistency, "session");
  assert.equal(projection.projectionDeclared.payload.matchDecided.consistencyLevel, "session");
});

test("reactivity class follows native-log or change-feed capability only", () => {
  const nativeProjection = declareProjection({
    name: "NativeTickets",
    readModel: "TicketList",
    eventTypes: ["Ticket.Opened"],
  });
  const postgresProjection = declareProjection({
    name: "PostgresTickets",
    readModel: "TicketList",
    eventTypes: ["Ticket.Opened"],
    sink: projectionSink({
      kind: "postgres",
      paradigm: "relational",
      capabilities: ["query", "change-feed"],
    }),
  });
  const olapProjection = declareProjection({
    name: "RevenueCube",
    readModel: "RevenueRollup",
    eventTypes: ["Invoice.Paid"],
    sink: projectionSink({
      kind: "warehouse",
      paradigm: "olap",
      capabilities: ["analytics", "batch"],
    }),
  });

  assert.equal(nativeProjection.reactive, true);
  assert.equal(nativeProjection.projectionDeclared.payload.reactivity.source, "native-log");
  assert.equal(postgresProjection.reactive, true);
  assert.equal(postgresProjection.projectionDeclared.payload.reactivity.source, "sink-change-feed");
  assert.equal(olapProjection.reactive, false);
  assert.equal(olapProjection.reactivityClass, "non-reactive");
  assert.equal(olapProjection.projectionDeclared.payload.reactivity.reactive, false);
  assert.equal(olapProjection.projectionDeclared.payload.reactivity.source, "no-change-feed");
});

test("declared level rides projection.Declared as a match.Decided outcome", () => {
  const projection = declareProjection({
    name: "Timeline",
    readModel: "ActivityTimeline",
    eventTypes: ["Activity.Posted"],
    consistency: "bounded-staleness",
    sink: projectionSink({
      kind: "mongo",
      paradigm: "document",
      capabilities: ["query", "change-feed"],
    }),
  });

  assert.equal(projection.projectionDeclared.type, PROJECTION_DECLARED_EVENT_TYPE);
  assert.equal(projection.projectionDeclared.payload.consistency, "bounded-staleness");
  assert.deepEqual(projection.projectionDeclared.payload.matchDecided, {
    outcome: "match.Decided",
    consistencyLevel: "bounded-staleness",
  });
});

test("use query over a non-reactive sink is a doctor warning, not a silent non-update", () => {
  const projection = declareProjection({
    name: "DailyRevenue",
    readModel: "DailyRevenue",
    eventTypes: ["Invoice.Paid"],
    sink: projectionSink({
      kind: "warehouse",
      paradigm: "olap",
      capabilities: ["analytics", "batch"],
    }),
  });

  assert.deepEqual(doctorUseQuery(projection), [
    {
      code: "non-reactive-use-query",
      severity: "warning",
      projection: "DailyRevenue",
      message:
        '"use query" depends on a non-reactive projection sink; use snapshot/repo reads or choose native/change-feed sink for live updates.',
    },
  ]);
});

test("strong cross-Camp consistency is flagged without being downgraded", () => {
  const projection = declareProjection({
    name: "GlobalAccountBalance",
    readModel: "AccountBalance",
    eventTypes: ["Ledger.Posted"],
    consistency: "strong",
    scope: "cross-camp",
  });

  assert.equal(projection.consistency, "strong");
  assert.equal(projection.projectionDeclared.payload.consistency, "strong");
  assert.deepEqual(assessConsistencyTradeoffs(projection), [
    {
      code: "strong-cross-camp-tradeoff",
      severity: "warning",
      projection: "GlobalAccountBalance",
      preservedLevel: "strong",
      message:
        "Strong cross-Camp consistency is preserved but must be surfaced as a latency/cost tradeoff.",
    },
  ]);
});

test("unknown consistency levels fail closed at declaration", () => {
  assert.throws(
    () =>
      declareProjection({
        name: "Unknown",
        readModel: "Unknown",
        eventTypes: ["Unknown.Emitted"],
        consistency: "linearizable",
      }),
    /unknown consistency/i,
  );
});
