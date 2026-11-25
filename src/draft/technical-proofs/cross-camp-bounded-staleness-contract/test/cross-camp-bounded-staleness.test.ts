import assert from "node:assert/strict";
import { test } from "vitest";

import { projection } from "../../native-log-projection-contract/src/native-log-projection.js";
import {
  PROJECTION_LAGGED_EVENT_TYPE,
  createCrossCampProjectionRuntime,
  declareCrossCampBoundedStalenessProjection,
} from "../src/cross-camp-bounded-staleness.js";

test("projection declares single-writer-Camp replication topology and explicit non-goals", () => {
  const contract = declareTicketsContract({ maxStalenessMs: 250 });

  assert.equal(contract.consistency, "bounded-staleness");
  assert.deepEqual(contract.replicationTopology, {
    kind: "single-writer-camp",
    ownerCampId: "prod-us",
    replicaCampIds: ["prod-eu"],
    readStream: "owner-replicated-read-stream",
  });
  assert.deepEqual(contract.scopeBoundary, {
    replicationTransport: "out-of-scope",
    activeActiveMerge: "out-of-scope",
    strongCrossCampConsistency: "out-of-scope",
  });
  assert.match(contract.honestLimit, /single-writer-camp is the cross-Camp write bottleneck/);
});

test("non-owner Camp serves same-fold bounded-staleness projection from replicated read-stream", () => {
  const contract = declareTicketsContract({ maxStalenessMs: 250 });
  const runtime = createCrossCampProjectionRuntime({ contract });

  runtime.appendOwnerEvent(ticketEvent("ticket:1", 1, 1000, "ticket.Opened", { title: "Login" }));
  runtime.appendOwnerEvent(ticketEvent("ticket:1", 2, 1010, "ticket.Commented", { body: "still broken" }));
  runtime.appendOwnerEvent(ticketEvent("ticket:2", 1, 1020, "ticket.Opened", { title: "Billing" }));

  runtime.replicateTo("prod-eu", {
    events: runtime.ownerReadStream(),
    ownerWatermarkMs: 1020,
    receivedAtMs: 1030,
  });

  const ownerRead = runtime.read("prod-us", { nowMs: 1030 });
  const replicaRead = runtime.read("prod-eu", { nowMs: 1030 });

  assert.deepEqual(replicaRead.rows, ownerRead.rows);
  assert.equal(replicaRead.source, "replicated-read-stream");
  assert.deepEqual(replicaRead.staleness, {
    guarantee: "bounded-staleness",
    status: "within-bound",
    flagged: false,
    boundMs: 250,
    observedLagMs: 10,
    ownerCampId: "prod-us",
    servedByCampId: "prod-eu",
    topology: "single-writer-camp",
  });
});

test("replicated-stream subscription carries staleness label with pushed result", () => {
  const pushed = [];
  const runtime = createCrossCampProjectionRuntime({
    contract: declareTicketsContract({ maxStalenessMs: 100 }),
  });

  runtime.subscribe({
    subscriptionId: "sub:prod-eu:tickets",
    campId: "prod-eu",
    client: pushCollector(pushed),
  });
  runtime.appendOwnerEvent(ticketEvent("ticket:1", 1, 1200, "ticket.Opened", { title: "Login" }));
  runtime.replicateTo("prod-eu", {
    events: runtime.ownerReadStream(),
    ownerWatermarkMs: 1200,
    receivedAtMs: 1235,
  });

  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:prod-eu:tickets",
      campId: "prod-eu",
      projection: "tickets",
      source: "replicated-read-stream",
      staleness: {
        guarantee: "bounded-staleness",
        status: "within-bound",
        flagged: false,
        boundMs: 100,
        observedLagMs: 35,
        ownerCampId: "prod-us",
        servedByCampId: "prod-eu",
        topology: "single-writer-camp",
      },
      rows: [["ticket:1", { comments: 0, status: "open", title: "Login" }]],
    },
  ]);
});

test("consistency-requiring write on non-owner routes home and is not applied locally", () => {
  const runtime = createCrossCampProjectionRuntime({
    contract: declareTicketsContract({ maxStalenessMs: 250 }),
  });

  runtime.appendOwnerEvent(ticketEvent("ticket:1", 1, 1000, "ticket.Opened", { title: "Login" }));
  runtime.replicateTo("prod-eu", {
    events: runtime.ownerReadStream(),
    ownerWatermarkMs: 1000,
    receivedAtMs: 1010,
  });

  const before = runtime.read("prod-eu", { nowMs: 1010 }).rows;
  const route = runtime.attemptWrite({
    campId: "prod-eu",
    requiresConsistency: true,
    command: {
      type: "ticket.open",
      streamId: "ticket:2",
      data: { title: "Should route home" },
    },
  });
  const after = runtime.read("prod-eu", { nowMs: 1015 }).rows;

  assert.deepEqual(route, {
    action: "route-home",
    targetCampId: "prod-us",
    sourceCampId: "prod-eu",
    appliedLocally: false,
    reason: "single-writer-camp requires consistency writes to run in the owner Camp",
    command: {
      type: "ticket.open",
      streamId: "ticket:2",
      data: { title: "Should route home" },
    },
  });
  assert.deepEqual(after, before);
});

test("stale read is flagged and emits projection.Lagged instead of looking fresh", () => {
  const runtime = createCrossCampProjectionRuntime({
    contract: declareTicketsContract({ maxStalenessMs: 50 }),
  });

  runtime.appendOwnerEvent(ticketEvent("ticket:1", 1, 1000, "ticket.Opened", { title: "Login" }));
  runtime.replicateTo("prod-eu", {
    events: runtime.ownerReadStream(),
    ownerWatermarkMs: 1000,
    receivedAtMs: 1010,
  });

  const read = runtime.read("prod-eu", { nowMs: 1110 });

  assert.equal(read.staleness.status, "exceeds-bound");
  assert.equal(read.staleness.flagged, true);
  assert.equal(read.staleness.boundMs, 50);
  assert.equal(read.staleness.observedLagMs, 110);
  assert.equal(read.source, "replicated-read-stream");
  assert.deepEqual(runtime.events().at(-1), {
    type: PROJECTION_LAGGED_EVENT_TYPE,
    streamId: "projection/tickets/lag/prod-eu",
    seq: 1,
    data: {
      projection: "tickets",
      ownerCampId: "prod-us",
      replicaCampId: "prod-eu",
      declaredBoundMs: 50,
      observedLagMs: 110,
      policyInput: true,
      reason: "replicated projection exceeded declared bounded-staleness",
    },
  });
});

test("replication lag spike emits projection.Lagged without widening declared bound", () => {
  const runtime = createCrossCampProjectionRuntime({
    contract: declareTicketsContract({ maxStalenessMs: 75 }),
  });

  runtime.appendOwnerEvent(ticketEvent("ticket:1", 1, 2000, "ticket.Opened", { title: "Login" }));
  const report = runtime.replicateTo("prod-eu", {
    events: runtime.ownerReadStream(),
    ownerWatermarkMs: 2000,
    receivedAtMs: 2200,
  });

  assert.equal(report.staleness.status, "exceeds-bound");
  assert.equal(report.staleness.boundMs, 75);
  assert.equal(report.staleness.observedLagMs, 200);
  assert.deepEqual(
    runtime.events().filter((event) => event.type === PROJECTION_LAGGED_EVENT_TYPE),
    [
      {
        type: PROJECTION_LAGGED_EVENT_TYPE,
        streamId: "projection/tickets/lag/prod-eu",
        seq: 1,
        data: {
          projection: "tickets",
          ownerCampId: "prod-us",
          replicaCampId: "prod-eu",
          declaredBoundMs: 75,
          observedLagMs: 200,
          policyInput: true,
          reason: "replicated projection exceeded declared bounded-staleness",
        },
      },
    ],
  );
});

function declareTicketsContract(options = {}) {
  return declareCrossCampBoundedStalenessProjection({
    projection: projection("tickets", {
      readModel: "support:tickets/ticket-view@1.0.0",
      rowSchema: {
        witRecord: "support:tickets/ticket-view@1.0.0",
        fields: [
          { name: "comments", type: "u32" },
          { name: "status", type: "string" },
          { name: "title", type: "string" },
        ],
      },
      key: (event) => event.streamId,
      initialState: { comments: 0, status: "unknown", title: "" },
      on: {
        "ticket.Opened": (state, event) => ({
          ...state,
          status: event.data.status ?? "open",
          title: event.data.title,
        }),
        "ticket.Commented": (state) => ({ ...state, comments: state.comments + 1 }),
      },
    }),
    ownerCampId: "prod-us",
    replicaCampIds: ["prod-eu"],
    ...options,
  });
}

function ticketEvent(streamId, seq, ownerTimestampMs, type, data) {
  return {
    id: `${streamId}-${seq}`,
    streamId,
    seq,
    type,
    ownerTimestampMs,
    data,
  };
}

function pushCollector(events) {
  return {
    push(event) {
      events.push(event);
    },
  };
}
