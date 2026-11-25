import assert from "node:assert/strict";
import { test } from "vitest";

import {
  PROJECTION_LAGGED_EVENT_TYPE,
  createProjectionLagHarness,
  evaluateConsistencyDeclaration,
} from "../src/projection-lag-consistency.js";

const ticketProjection = {
  name: "tickets",
  consistency: {
    level: "bounded-staleness",
    boundMs: 5000,
  },
  sink: {
    id: "relational-cache",
    capability: "change-feed",
  },
  key(event) {
    return event.data.ticketId;
  },
  initialState() {
    return {
      status: "missing",
      version: 0,
    };
  },
  on: {
    "ticket.Opened": (state, event) => ({
      ...state,
      status: "open",
      title: event.data.title,
      version: event.seq,
    }),
    "ticket.Commented": (state, event) => ({
      ...state,
      lastComment: event.data.comment,
      version: event.seq,
    }),
  },
};

function createHarness(overrides = {}) {
  return createProjectionLagHarness({
    projection: ticketProjection,
    ownerCamp: "prod-us",
    readerCamp: "prod-eu",
    lagBoundMs: 5000,
    ...overrides,
  });
}

function ticketEvent(seq, occurredAtMs, type, data = {}) {
  return {
    streamId: `ticket/${data.ticketId ?? "T-1"}`,
    seq,
    type,
    occurredAtMs,
    data: {
      tenant: "acme",
      ticketId: "T-1",
      ...data,
    },
  };
}

test("sustained write load past the declared bound emits projection.Lagged without widening the bound", () => {
  const harness = createHarness();

  harness.appendOwnerEvents([
    ticketEvent(1, 0, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, 4000, "ticket.Commented", { comment: "owner update" }),
    ticketEvent(3, 11000, "ticket.Commented", { comment: "still hot" }),
  ]);
  harness.replicateChangeFeed({ throughSeq: 1, receivedAtMs: 1000 });

  const read = harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "bounded-staleness",
    nowMs: 11000,
  });

  assert.equal(read.readClass, "bounded-staleness");
  assert.deepEqual(read.staleness, {
    status: "exceeds-bound",
    declaredBoundMs: 5000,
    observedLagMs: 11000,
  });
  assert.deepEqual(harness.events(), [
    {
      type: PROJECTION_LAGGED_EVENT_TYPE,
      streamId: "projection/tickets/lag/prod-us/relational-cache",
      seq: 1,
      occurredAtMs: 11000,
      data: {
        projection: "tickets",
        source: "change-feed-sink-cache",
        ownerCamp: "prod-us",
        readerCamp: "prod-eu",
        sink: "relational-cache",
        tenant: "acme",
        declaredBoundMs: 5000,
        observedLagMs: 11000,
        consistency: "bounded-staleness",
        status: "lagged",
      },
    },
  ]);
});

test("change-feed sink reads carry bounded-staleness labels and never claim freshness", () => {
  const harness = createHarness();

  harness.appendOwnerEvents([
    ticketEvent(1, 0, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, 6000, "ticket.Commented", { comment: "owner update" }),
  ]);
  harness.replicateChangeFeed({ throughSeq: 1, receivedAtMs: 500 });

  const read = harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "bounded-staleness",
    nowMs: 6000,
  });

  assert.equal(read.source, "change-feed-sink-cache");
  assert.equal(read.freshnessClaim, "bounded-staleness");
  assert.notEqual(read.freshnessClaim, "fresh");
  assert.deepEqual(read.labels, ["bounded-staleness", "projection-lagged"]);
});

test("native session reads see owner writes while eventual sink reads remain honestly stale", () => {
  const harness = createHarness();

  harness.appendOwnerEvents([
    ticketEvent(1, 0, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, 2000, "ticket.Commented", { comment: "my write" }),
  ]);
  harness.replicateChangeFeed({ throughSeq: 1, receivedAtMs: 500 });

  const sessionRead = harness.readProjection({
    source: "native-log",
    tenant: "acme",
    consistency: "session",
    sessionSeq: 2,
    nowMs: 2000,
  });
  const eventualRead = harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "eventual",
    nowMs: 2000,
  });

  assert.equal(sessionRead.rows[0].lastComment, "my write");
  assert.equal(sessionRead.freshnessClaim, "read-your-writes");
  assert.equal(eventualRead.rows[0].lastComment, undefined);
  assert.equal(eventualRead.freshnessClaim, "eventual-stale-ok");
  assert.deepEqual(eventualRead.staleness, {
    status: "stale-ok",
    observedLagMs: 2000,
  });
});

test("hobo doctor reports each read class, including lagging sink-cache reads", () => {
  const harness = createHarness();

  harness.appendOwnerEvents([
    ticketEvent(1, 0, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, 8000, "ticket.Commented", { comment: "owner update" }),
  ]);
  harness.replicateChangeFeed({ throughSeq: 1, receivedAtMs: 500 });

  harness.readProjection({
    source: "native-log",
    tenant: "acme",
    consistency: "session",
    sessionSeq: 2,
    nowMs: 8000,
  });
  harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "bounded-staleness",
    nowMs: 8000,
  });
  harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "eventual",
    nowMs: 8000,
  });

  assert.deepEqual(harness.doctor(), [
    {
      query: "tickets via native-log",
      source: "native-log",
      readClass: "session",
      consistency: "session",
      freshness: "read-your-writes",
      severity: "info",
    },
    {
      query: "tickets via change-feed-sink-cache",
      source: "change-feed-sink-cache",
      readClass: "bounded-staleness",
      consistency: "bounded-staleness",
      lagStatus: "exceeds-bound",
      severity: "warning",
    },
    {
      query: "tickets via change-feed-sink-cache",
      source: "change-feed-sink-cache",
      readClass: "eventual",
      consistency: "eventual",
      freshness: "stale-ok",
      severity: "info",
    },
  ]);
});

test("transient burst over the bound fires and then clears projection.Lagged", () => {
  const harness = createHarness();

  harness.appendOwnerEvents([
    ticketEvent(1, 0, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, 7000, "ticket.Commented", { comment: "burst" }),
  ]);
  harness.replicateChangeFeed({ throughSeq: 1, receivedAtMs: 500 });
  harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "bounded-staleness",
    nowMs: 7000,
  });

  harness.replicateChangeFeed({ throughSeq: 2, receivedAtMs: 7200 });
  harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "bounded-staleness",
    nowMs: 7200,
  });

  assert.deepEqual(
    harness.events().map((event) => event.data.status),
    ["lagged", "cleared"],
  );
  assert.deepEqual(harness.lagState(), {
    active: false,
    declaredBoundMs: 5000,
    observedLagMs: 0,
  });
});

test("a sink that silently falls behind without projection.Lagged is caught", () => {
  const harness = createHarness({ emitLagEvents: false });

  harness.appendOwnerEvents([
    ticketEvent(1, 0, "ticket.Opened", { title: "router down" }),
    ticketEvent(2, 9000, "ticket.Commented", { comment: "owner update" }),
  ]);
  harness.replicateChangeFeed({ throughSeq: 1, receivedAtMs: 500 });
  harness.readProjection({
    source: "change-feed-sink",
    tenant: "acme",
    consistency: "bounded-staleness",
    nowMs: 9000,
  });

  assert.deepEqual(harness.auditLagSignals(), [
    {
      projection: "tickets",
      sink: "relational-cache",
      severity: "error",
      reason: "lag-over-bound-without-projection.Lagged",
      declaredBoundMs: 5000,
      observedLagMs: 9000,
    },
  ]);
});

test("strong cross-Camp declarations that cannot be met are flagged, not downgraded", () => {
  assert.deepEqual(
    evaluateConsistencyDeclaration({
      entity: "Ticket",
      declaredConsistency: "strong",
      topology: "cross-camp",
      source: "change-feed-sink-cache",
    }),
    {
      ok: false,
      entity: "Ticket",
      declaredConsistency: "strong",
      topology: "cross-camp",
      source: "change-feed-sink-cache",
      effectiveConsistency: null,
      action: "flag",
      reason: "strong-cross-camp-unavailable",
      message:
        "Ticket declares strong cross-Camp reads, but change-feed-sink-cache can only prove bounded-staleness.",
    },
  );
});
