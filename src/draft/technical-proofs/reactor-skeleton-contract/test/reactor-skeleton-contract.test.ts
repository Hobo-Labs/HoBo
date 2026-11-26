import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createInMemoryReactor,
  defineMaterialization,
  isSeqAtLeast,
} from "../src/reactor-skeleton-contract.js";

test("subscribe then append in read-set pushes recomputed materialization at new seq", () => {
  const pushed = [];
  const reactor = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  reactor.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(pushed),
  });

  reactor.append(ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login" }));

  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:open-tickets",
      seq: { "ticket:1": 1 },
      result: [{ id: "ticket:1", title: "Login", status: "open", comments: 0 }],
    },
  ]);
});

test("append outside every read-set wakes no subscriptions", () => {
  const pushed = [];
  const reactor = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  reactor.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(pushed),
  });

  const wakeReport = reactor.append(
    ticketEvent("billing:1", 1, "invoice.Paid", { amount: 4200 }),
  );

  assert.deepEqual(wakeReport, {
    streamId: "billing:1",
    eventType: "invoice.Paid",
    wokenSubscriptions: [],
  });
  assert.deepEqual(pushed, []);
});

test("burst appends produce monotonic, non-regressing pushes", () => {
  const pushed = [];
  const reactor = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  reactor.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(pushed),
  });

  reactor.append(ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login" }));
  reactor.append(ticketEvent("ticket:1", 2, "ticket.Commented", { body: "first" }));
  reactor.append(ticketEvent("ticket:1", 3, "ticket.Commented", { body: "second" }));

  assert.deepEqual(
    pushed.map((event) => event.seq),
    [{ "ticket:1": 1 }, { "ticket:1": 2 }, { "ticket:1": 3 }],
  );
  assert.equal(
    pushed.every((event, index, events) =>
      index === 0 || isSeqAtLeast(event.seq, events[index - 1].seq),
    ),
    true,
  );
  assert.deepEqual(pushed.at(-1).result, [
    { id: "ticket:1", title: "Login", status: "open", comments: 2 },
  ]);
});

test("multi-stream materialization advances each stream independently", () => {
  const pushed = [];
  const reactor = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  reactor.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(pushed),
  });

  reactor.append(ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login" }));
  reactor.append(ticketEvent("ticket:2", 1, "ticket.Opened", { title: "Billing" }));
  reactor.append(ticketEvent("ticket:1", 2, "ticket.Commented", { body: "first" }));

  assert.deepEqual(pushed.at(-1).seq, {
    "ticket:1": 2,
    "ticket:2": 1,
  });
  assert.deepEqual(pushed.at(-1).result, [
    { id: "ticket:1", title: "Login", status: "open", comments: 1 },
    { id: "ticket:2", title: "Billing", status: "open", comments: 0 },
  ]);
});

test("subscription args isolate materialized values under the same read-set", () => {
  const openPushed = [];
  const closedPushed = [];
  const reactor = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  reactor.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    args: { status: "open" },
    client: pushCollector(openPushed),
  });
  reactor.subscribe({
    subscriptionId: "sub:closed-tickets",
    materialization: "openTickets",
    args: { status: "closed" },
    client: pushCollector(closedPushed),
  });

  reactor.append(
    ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login", status: "open" }),
  );
  const wakeReport = reactor.append(
    ticketEvent("ticket:2", 1, "ticket.Opened", { title: "Billing", status: "closed" }),
  );

  assert.deepEqual(wakeReport.wokenSubscriptions, [
    "sub:closed-tickets",
    "sub:open-tickets",
  ]);
  assert.deepEqual(openPushed.map((event) => event.result), [
    [{ id: "ticket:1", title: "Login", status: "open", comments: 0 }],
  ]);
  assert.deepEqual(closedPushed.map((event) => event.result), [
    [{ id: "ticket:2", title: "Billing", status: "closed", comments: 0 }],
  ]);
});

test("identical recompute suppresses a spurious push", () => {
  const pushed = [];
  const reactor = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  reactor.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(pushed),
  });

  reactor.append(ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login" }));
  const wakeReport = reactor.append(
    ticketEvent("ticket:1", 2, "ticket.Heartbeat", { status: "same" }),
  );

  assert.deepEqual(wakeReport.wokenSubscriptions, ["sub:open-tickets"]);
  assert.equal(pushed.length, 1);
  assert.deepEqual(pushed[0].seq, { "ticket:1": 1 });
});

test("restart rebuilds active subscriptions from persisted subscription projection", () => {
  const beforeRestart = [];
  const afterRestart = [];
  const first = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  first.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(beforeRestart),
  });
  first.append(ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login" }));

  const rebuilt = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
    eventLog: first.exportEventLog(),
    subscriptionFacts: first.exportSubscriptionFacts(),
  });
  rebuilt.attachClient("sub:open-tickets", pushCollector(afterRestart));
  rebuilt.append(ticketEvent("ticket:1", 2, "ticket.Commented", { body: "after restart" }));

  assert.deepEqual(afterRestart, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:open-tickets",
      seq: { "ticket:1": 2 },
      result: [{ id: "ticket:1", title: "Login", status: "open", comments: 1 }],
    },
  ]);
});

test("restart leaves closed subscriptions out of the rebuilt read-set index", () => {
  const pushed = [];
  const first = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
  });

  first.subscribe({
    subscriptionId: "sub:open-tickets",
    materialization: "openTickets",
    client: pushCollector(pushed),
  });

  const rebuilt = createInMemoryReactor({
    materializations: [defineOpenTicketsMaterialization()],
    eventLog: first.exportEventLog(),
    subscriptionFacts: [
      ...first.exportSubscriptionFacts(),
      { type: "subscription.Closed", subscriptionId: "sub:open-tickets" },
    ],
  });

  assert.throws(
    () => rebuilt.attachClient("sub:open-tickets", pushCollector(pushed)),
    /unknown subscription: sub:open-tickets/,
  );
  assert.deepEqual(
    rebuilt.append(ticketEvent("ticket:1", 1, "ticket.Opened", { title: "Login" })),
    {
      streamId: "ticket:1",
      eventType: "ticket.Opened",
      wokenSubscriptions: [],
    },
  );
  assert.deepEqual(pushed, []);
});

function defineOpenTicketsMaterialization() {
  return defineMaterialization({
    name: "openTickets",
    readSet: [
      { kind: "eventType", value: "ticket.Opened" },
      { kind: "eventType", value: "ticket.Commented" },
      { kind: "eventType", value: "ticket.Heartbeat" },
    ],
    initialState: [],
    fold(state, event, args = {}) {
      if (event.type === "ticket.Heartbeat") {
        return state;
      }

      if (event.type === "ticket.Opened") {
        const nextState = [
          ...state,
          {
            id: event.streamId,
            title: event.data.title,
            status: event.data.status ?? "open",
            comments: 0,
          },
        ];
        return filterByStatus(nextState, args.status);
      }

      if (event.type === "ticket.Commented") {
        return state.map((row) =>
          row.id === event.streamId ? { ...row, comments: row.comments + 1 } : row,
        );
      }

      return state;
    },
  });
}

function filterByStatus(rows, status) {
  if (!status) {
    return rows;
  }
  return rows.filter((row) => row.status === status);
}

function ticketEvent(streamId, seq, type, data) {
  return { streamId, seq, type, data };
}

function pushCollector(events) {
  return {
    push(event) {
      events.push(event);
    },
  };
}
