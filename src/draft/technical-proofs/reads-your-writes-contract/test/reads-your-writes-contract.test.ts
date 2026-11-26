import assert from "node:assert/strict";
import { test } from "vitest";

import { command } from "../../cqrs-command-aggregate-contract/src/cqrs-command-aggregate-contract.js";
import { defineMaterialization } from "../../reactor-skeleton-contract/src/reactor-skeleton-contract.js";
import {
  declareProjection,
  projectionSink,
} from "../../projection-consistency-reactivity-contract/src/projection-contract.js";
import {
  ReadsYourWritesAckViolationError,
  assertAckAdvanced,
  classifyReadGuarantee,
  createReadYourWritesRuntime,
} from "../src/reads-your-writes-contract.js";

test("command ack waits until a native subscription advances to the command seq", () => {
  const runtime = createReadYourWritesRuntime({
    materializations: [openTicketsMaterialization()],
  });

  const subscription = runtime.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
  });
  const ack = runtime.executeCommandAndAck(openTicketCommand, {
    id: "ticket:1",
    title: "Login",
  });

  assert.deepEqual(subscription.readSet, [
    { kind: "eventType", value: "ticket.Commented" },
    { kind: "eventType", value: "ticket.Opened" },
  ]);
  assert.deepEqual(ack.seqFloor, { "ticket:1": 1 });
  assert.deepEqual(ack.advancedSubscriptions, [
    { subscriptionId: "sub:open-tickets", seq: { "ticket:1": 1 } },
  ]);
  assert.deepEqual(runtime.pushed("sub:open-tickets").at(-1), {
    type: "subscription.Pushed",
    subscriptionId: "sub:open-tickets",
    seq: { "ticket:1": 1 },
    result: [{ id: "ticket:1", title: "Login", status: "open" }],
  });
});

test("multi-stream materialization advances a per-stream vector, not a scalar", () => {
  const runtime = createReadYourWritesRuntime({
    materializations: [openTicketsMaterialization()],
  });

  runtime.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
  });
  runtime.executeCommandAndAck(openTicketCommand, { id: "ticket:1", title: "Login" });
  runtime.executeCommandAndAck(openTicketCommand, { id: "ticket:2", title: "Billing" });
  runtime.executeCommandAndAck(commentTicketCommand, { id: "ticket:1", body: "still broken" });

  assert.deepEqual(runtime.subscriptionSeq("sub:open-tickets"), {
    "ticket:1": 2,
    "ticket:2": 1,
  });
  assert.deepEqual(
    runtime.pushed("sub:open-tickets").map((event) => event.seq),
    [{ "ticket:1": 1 }, { "ticket:1": 1, "ticket:2": 1 }],
  );
});

test("an ack that would return before subscription advance is a detectable bug", () => {
  assert.throws(
    () =>
      assertAckAdvanced({
        subscriptionId: "sub:open-tickets",
        subscriptionSeq: { "ticket:1": 1 },
        seqFloor: { "ticket:1": 2 },
      }),
    ReadsYourWritesAckViolationError,
  );
});

test("clock-skewed or stale client pushes cannot regress a stream seq", () => {
  const runtime = createReadYourWritesRuntime({
    materializations: [openTicketsMaterialization()],
  });

  runtime.recordClientPush("sub:open-tickets", { "ticket:1": 2 });

  assert.throws(
    () => runtime.recordClientPush("sub:open-tickets", { "ticket:1": 1 }),
    /regressed ticket:1/,
  );
});

test("change-feed sink reads are labeled bounded-staleness, not strict reads-your-writes", () => {
  const nativeProjection = declareProjection({
    name: "NativeTickets",
    readModel: "TicketList",
    eventTypes: ["ticket.Opened"],
  });
  const changeFeedProjection = declareProjection({
    name: "PostgresTickets",
    readModel: "TicketList",
    eventTypes: ["ticket.Opened"],
    sink: projectionSink({
      kind: "postgres",
      paradigm: "relational",
      capabilities: ["query", "change-feed"],
    }),
  });

  assert.deepEqual(classifyReadGuarantee(nativeProjection), {
    guarantee: "read-your-writes",
    strictReadYourWrites: true,
    source: "native-log",
  });
  assert.deepEqual(classifyReadGuarantee(changeFeedProjection), {
    guarantee: "bounded-staleness",
    strictReadYourWrites: false,
    source: "sink-change-feed",
  });
});

const openTicketCommand = command(
  "ticket.open",
  {
    key: (input) => input.id,
    initialState: { opened: false },
    fold(state, event) {
      if (event.type === "ticket.Opened") {
        return { opened: true };
      }
      return state;
    },
  },
  (input, ctx) => {
    if (ctx.state.opened) {
      return { alreadyOpen: true };
    }
    return ctx.emit("ticket.Opened", { title: input.title, status: "open" });
  },
);

const commentTicketCommand = command(
  "ticket.comment",
  {
    key: (input) => input.id,
    initialState: { comments: 0 },
    fold(state, event) {
      if (event.type === "ticket.Commented") {
        return { comments: state.comments + 1 };
      }
      return state;
    },
  },
  (input, ctx) => ctx.emit("ticket.Commented", { body: input.body }),
);

function openTicketsMaterialization() {
  return defineMaterialization({
    name: "openTickets",
    readSet: [
      { kind: "eventType", value: "ticket.Opened" },
      { kind: "eventType", value: "ticket.Commented" },
    ],
    initialState: [],
    fold(state, event) {
      if (event.type !== "ticket.Opened") {
        return state;
      }
      if (state.some((ticket) => ticket.id === event.streamId)) {
        return state;
      }
      return [
        ...state,
        {
          id: event.streamId,
          title: event.data.title,
          status: event.data.status,
        },
      ];
    },
  });
}
