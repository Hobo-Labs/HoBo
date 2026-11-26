import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "vitest";

import {
  createProjectionPort,
  nativeLogSink,
  projectionDeclared,
  projectionLagged,
  projectionSinkRebound,
  projectionSpec,
  sinkRequirementMiss,
} from "../src/projection-contract.js";

const generatedProjectionPath = join(
  import.meta.dirname,
  "..",
  "generated",
  "interfaces",
  "hobo-projection-port.d.ts",
);

test("jco generates typed hobo:projection port bindings", async () => {
  const bindings = await readFile(generatedProjectionPath, "utf8");

  assert.match(bindings, /declareProjection\(/);
  assert.match(bindings, /materialize\(/);
  assert.match(bindings, /rebuild\(/);
  assert.match(bindings, /readRaw\(/);
  assert.match(bindings, /ProjectionSpec/);
  assert.match(bindings, /ProjectionDeclared/);
  assert.match(bindings, /ProjectionLagged/);
  assert.match(bindings, /ProjectionSinkRebound/);
});

test("projection.Declared round-trips through the EventStore with stable payload", () => {
  const projection = projectionSpec({
    name: "orders-by-status",
    readModel: "shop:orders/order-summary@1.0.0",
    readSet: ["order.Opened", "order.Paid"],
    fold: "foldOrdersByStatus",
    reactivity: "reactive",
    consistency: "session",
    sink: nativeLogSink(),
  });
  const port = createProjectionPort({ knownEventTypes: ["order.Opened", "order.Paid"] });

  port.declare(projection);
  const event = projectionDeclared(projection, {
    streamId: "projection/orders-by-status",
    seq: 1,
  });
  port.eventStore.append("projection/orders-by-status", event, { expectedSeq: 0 });

  assert.deepEqual(port.eventStore.read("projection/orders-by-status"), [event]);
  assert.deepEqual(port.eventStore.replay("projection/orders-by-status"), [event]);
  assert.deepEqual(event.data, {
    name: "orders-by-status",
    readModel: "shop:orders/order-summary@1.0.0",
    readSet: ["order.Opened", "order.Paid"],
    reactivity: "reactive",
    consistency: "session",
    sink: { type: "projection-sink", paradigm: "native", reactive: true },
  });
});

test("projection folds are deterministic and read-only by contract", () => {
  const port = createProjectionPort({ knownEventTypes: ["ticket.Opened"] });

  assert.throws(
    () =>
      port.declare(
        projectionSpec({
          name: "tickets",
          readModel: "support:tickets/ticket-view@1.0.0",
          readSet: ["ticket.Opened"],
          fold: "foldTickets",
          capabilitiesUsed: ["step"],
          reactivity: "reactive",
          consistency: "session",
          sink: nativeLogSink(),
        }),
      ),
    /read-only/i,
  );
});

test("projection sink taxonomy enumerates supported paradigms", () => {
  const port = createProjectionPort({ knownEventTypes: ["ticket.Opened"] });

  assert.deepEqual(port.sinkParadigms, [
    "native",
    "relational",
    "document",
    "kv",
    "wide-column",
    "graph",
    "vector",
    "object-lake",
    "olap",
  ]);
});

test("declaring an unknown event type fails before materialization", () => {
  const port = createProjectionPort({ knownEventTypes: ["ticket.Opened"] });

  assert.throws(
    () =>
      port.declare(
        projectionSpec({
          name: "tickets",
          readModel: "support:tickets/ticket-view@1.0.0",
          readSet: ["ticket.Opened", "ticket.Deleted"],
          fold: "foldTickets",
          reactivity: "reactive",
          consistency: "session",
          sink: nativeLogSink(),
        }),
      ),
    /unknown event type: ticket\.Deleted/,
  );
});

test("missing sink adapter returns require-miss instead of crashing at runtime", () => {
  const port = createProjectionPort({
    knownEventTypes: ["ticket.Opened"],
    registeredSinkParadigms: ["native"],
  });
  const projection = projectionSpec({
    name: "tickets",
    readModel: "support:tickets/ticket-view@1.0.0",
    readSet: ["ticket.Opened"],
    fold: "foldTickets",
    reactivity: "non-reactive",
    consistency: "eventual",
    sink: { type: "projection-sink", paradigm: "graph", reactive: false },
  });

  assert.deepEqual(port.declare(projection), sinkRequirementMiss(projection, "graph"));
});

test("projection lag and sink rebound events validate reused event-family boundaries", () => {
  const lagged = projectionLagged("orders-by-status", {
    streamId: "projection/orders-by-status",
    seq: 7,
    observedLagMs: 1600,
    boundMs: 1000,
    policyInput: true,
  });
  const rebound = projectionSinkRebound("orders-by-status", {
    streamId: "projection/orders-by-status",
    seq: 8,
    matchDecisionId: "match.Decided/abc",
    from: nativeLogSink(),
    to: { type: "projection-sink", paradigm: "relational", reactive: true },
  });

  assert.equal(lagged.type, "projection.Lagged");
  assert.equal(rebound.type, "projection.SinkRebound");
  assert.equal(rebound.data.reusedEventFamilies.matchDecision, "match.Decided");
  assert.equal(rebound.data.reusedEventFamilies.changeFeed, "data.Changed");
  assert.equal(rebound.data.reusedEventFamilies.schemaChange, "migration.*");
  assert.equal(rebound.data.reusedEventFamilies.adoption, "resource.Adopted");
});
