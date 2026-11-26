import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ProjectionFoldError,
  createNativeProjectionLog,
  declareNativeProjection,
  projection,
} from "../src/native-log-projection.js";
import { isJsonString } from "../src/json.js";


test("native projection folds fixture event stream into read model at seq", () => {
  const tickets = defineTicketProjection();
  const log = createNativeProjectionLog([
    ticketEvent("ticket-2", 1, "ticket.Opened", { title: "Billing", status: "open" }),
    ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first reply" }),
    ticketEvent("ticket-1", 1, "ticket.Opened", { title: "Login", status: "open" }),
  ]);

  const snapshot = log.materialize(tickets);

  assert.deepEqual(snapshot, {
    projection: "tickets",
    readModel: "support:tickets/ticket-view@1.0.0",
    rowSchema: ticketRowSchema(),
    readSet: ["ticket.Commented", "ticket.Opened"],
    reactivity: {
      class: "reactive",
      source: "native-log",
      reason: "event log is the change stream",
    },
    seq: {
      "ticket-1": 2,
      "ticket-2": 1,
    },
    rows: [
      ["ticket-1", { comments: 1, status: "open", title: "Login" }],
      ["ticket-2", { comments: 0, status: "open", title: "Billing" }],
    ],
  });
});

test("native projection is reactive by construction without a provider sink", () => {
  const tickets = defineTicketProjection();
  const log = createNativeProjectionLog();

  const before = log.materialize(tickets);
  log.append(ticketEvent("ticket-1", 1, "ticket.Opened", { title: "Login", status: "open" }));
  const after = log.materialize(tickets);

  assert.equal(before.reactivity.class, "reactive");
  assert.equal(after.reactivity.source, "native-log");
  assert.deepEqual(before.rows, []);
  assert.deepEqual(after.rows, [["ticket-1", { comments: 0, status: "open", title: "Login" }]]);
});

test("projection declaration emits read-set and native reactive class", () => {
  const tickets = defineTicketProjection({
    indexHints: ["status", "title"],
  });

  assert.deepEqual(declareNativeProjection(tickets, { streamId: "projection/tickets", seq: 7 }), {
    type: "projection.Declared",
    streamId: "projection/tickets",
    seq: 7,
    data: {
      name: "tickets",
      readModel: "support:tickets/ticket-view@1.0.0",
      rowSchema: ticketRowSchema(),
      readSet: ["ticket.Commented", "ticket.Opened"],
      reactivityClass: "reactive",
      sink: { type: "projection-sink", paradigm: "native", reactive: true },
      indexHints: ["status", "title"],
    },
  });
});

test("folds referencing step or writes are rejected before declaration", () => {
  assert.throws(
    () =>
      defineTicketProjection({
        capabilitiesUsed: ["step", "emit"],
      }),
    /read-only/i,
  );
});

test("same-key events fold deterministically in stream seq order", () => {
  const tickets = defineTicketProjection();
  const log = createNativeProjectionLog([
    ticketEvent("ticket-1", 3, "ticket.Commented", { comment: "second" }),
    ticketEvent("ticket-1", 1, "ticket.Opened", { title: "Login", status: "open" }),
    ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
  ]);

  assert.deepEqual(log.materialize(tickets).rows, [
    ["ticket-1", { comments: 2, status: "open", title: "Login" }],
  ]);
});

test("events outside the read-set never land in the projection", () => {
  const tickets = defineTicketProjection();
  const log = createNativeProjectionLog([
    ticketEvent("ticket-1", 1, "ticket.Opened", { title: "Login", status: "open" }),
    ticketEvent("ticket-1", 2, "ticket.InternalNoteAdded", { note: "ignore" }),
  ]);

  assert.deepEqual(log.materialize(tickets).seq, { "ticket-1": 1 });
  assert.deepEqual(log.materialize(tickets).rows, [
    ["ticket-1", { comments: 0, status: "open", title: "Login" }],
  ]);
});

test("malformed event bodies surface as fold errors instead of silent drops", () => {
  const tickets = defineTicketProjection();
  const log = createNativeProjectionLog([
    ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open" }),
  ]);

  assert.throws(() => log.materialize(tickets), ProjectionFoldError);
});

function defineTicketProjection(overrides = {}) {
  return projection("tickets", {
    readModel: "support:tickets/ticket-view@1.0.0",
    rowSchema: ticketRowSchema(),
    key: (event) => event.streamId,
    initialState: { comments: 0, status: "unknown", title: "" },
    on: {
      "ticket.Opened": (state, event) => {
        if (!isJsonString(event.data.title)) {
          throw new Error("ticket.Opened requires title");
        }
        return { ...state, status: event.data.status, title: event.data.title };
      },
      "ticket.Commented": (state) => {
        return { ...state, comments: state.comments + 1 };
      },
    },
    ...overrides,
  });
}

function ticketRowSchema() {
  return {
    witRecord: "support:tickets/ticket-view@1.0.0",
    fields: [
      { name: "comments", type: "u32" },
      { name: "status", type: "string" },
      { name: "title", type: "string" },
    ],
  };
}

function ticketEvent(streamId, seq, type, data) {
  return {
    id: `${streamId}-${seq}`,
    streamId,
    seq,
    type,
    data,
  };
}
