import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createSubscriptionOpened,
  createSubscriptionRecomputed,
  createSubscriptionClosed,
  createSubscriptionPushed,
  createDataChanged,
  appendSubscriptionFact,
  rebuildSubscriptionState,
  detectChangeFeedAnomalies,
  hashReadSet,
  validateSubscriptionEvent,
} from "../src/materialization-subscription-contract.js";

test("subscription and data.Changed schemas round-trip through the contract validators", () => {
  const opened = createSubscriptionOpened({
    subscriptionId: "sub-open-tickets",
    materialization: "openTickets",
    args: { team: "infra" },
    readSet: [{ kind: "eventType", value: "ticket.*" }],
    lastSeq: { "ticket:1": 3 },
  });

  const recomputed = createSubscriptionRecomputed({
    subscriptionId: opened.subscriptionId,
    seq: { "ticket:1": 4 },
    readSet: [{ kind: "eventType", value: "ticket.*" }],
  });

  const closed = createSubscriptionClosed({
    subscriptionId: opened.subscriptionId,
    reason: "client-disconnected",
  });

  const changed = createDataChanged({
    resource: "tickets",
    key: "ticket-1",
    op: "update",
    sourceSeq: 9,
  });

  assert.equal(validateSubscriptionEvent(opened).type, "subscription.Opened");
  assert.equal(validateSubscriptionEvent(recomputed).type, "subscription.Recomputed");
  assert.equal(validateSubscriptionEvent(closed).type, "subscription.Closed");
  assert.equal(validateSubscriptionEvent(changed).type, "data.Changed");
});

test("read-set hash changes iff read-set membership changes", () => {
  const readSet = [
    { kind: "stream", value: "ticket:1" },
    { kind: "eventType", value: "ticket.Opened" },
  ];
  const sameMembersDifferentOrder = [
    { kind: "eventType", value: "ticket.Opened" },
    { kind: "stream", value: "ticket:1" },
  ];
  const sameMembersWithDuplicate = [
    { kind: "stream", value: "ticket:1" },
    { kind: "eventType", value: "ticket.Opened" },
    { kind: "stream", value: "ticket:1" },
  ];
  const differentReadSet = [
    { kind: "eventType", value: "ticket.Opened" },
    { kind: "stream", value: "ticket:2" },
  ];

  assert.equal(hashReadSet(readSet), hashReadSet(sameMembersDifferentOrder));
  assert.equal(hashReadSet(readSet), hashReadSet(sameMembersWithDuplicate));
  assert.notEqual(hashReadSet(readSet), hashReadSet(differentReadSet));
});

test("pushed results stay ephemeral while subscriptions rebuild from persisted facts", () => {
  const log = [];
  const opened = createSubscriptionOpened({
    subscriptionId: "sub-open-tickets",
    materialization: "openTickets",
    args: { team: "infra" },
    readSet: [
      { kind: "eventType", value: "ticket.Opened" },
      { kind: "eventType", value: "ticket.Closed" },
    ],
    lastSeq: { "ticket:1": 1 },
  });
  const recomputed = createSubscriptionRecomputed({
    subscriptionId: opened.subscriptionId,
    seq: { "ticket:1": 3, "ticket:2": 1 },
    readSet: [
      { kind: "eventType", value: "ticket.Closed" },
      { kind: "eventType", value: "ticket.Opened" },
    ],
  });
  const pushed = createSubscriptionPushed({
    subscriptionId: opened.subscriptionId,
    seq: recomputed.seq,
    result: [{ id: "ticket-2", title: "network partition" }],
  });

  appendSubscriptionFact(log, opened);
  appendSubscriptionFact(log, recomputed);
  appendSubscriptionFact(log, pushed);

  assert.deepEqual(
    log.map((event) => event.type),
    ["subscription.Opened", "subscription.Recomputed"],
  );

  assert.deepEqual(rebuildSubscriptionState(log, opened.subscriptionId), {
    subscriptionId: opened.subscriptionId,
    materialization: "openTickets",
    args: { team: "infra" },
    readSet: [
      { kind: "eventType", value: "ticket.Closed" },
      { kind: "eventType", value: "ticket.Opened" },
    ],
    lastSeq: { "ticket:1": 3, "ticket:2": 1 },
    status: "active",
  });
});

test("data.Changed guards invalid ops and detects unordered or duplicate key changes", () => {
  assert.throws(
    () =>
      createDataChanged({
        resource: "tickets",
        key: "ticket-1",
        op: "merge",
        sourceSeq: 1,
      }),
    /op must be one of/,
  );

  const changes = [
    createDataChanged({ resource: "tickets", key: "ticket-1", op: "insert", sourceSeq: 1 }),
    createDataChanged({ resource: "tickets", key: "ticket-1", op: "update", sourceSeq: 1 }),
    createDataChanged({ resource: "tickets", key: "ticket-2", op: "insert", sourceSeq: 5 }),
    createDataChanged({ resource: "tickets", key: "ticket-2", op: "delete", sourceSeq: 4 }),
  ];

  assert.deepEqual(detectChangeFeedAnomalies(changes), [
    {
      resource: "tickets",
      key: "ticket-1",
      reason: "duplicate-source-seq",
      sourceSeq: 1,
    },
    {
      resource: "tickets",
      key: "ticket-2",
      reason: "non-monotonic-source-seq",
      previousSourceSeq: 5,
      sourceSeq: 4,
    },
  ]);
});
