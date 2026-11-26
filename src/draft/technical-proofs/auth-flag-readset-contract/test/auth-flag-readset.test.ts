import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createAuthFlagReadsetReactor,
  defineMaterialization,
} from "../src/auth-flag-readset.js";

test("session.Revoked recomputes affected subscriptions and denies without client polling", () => {
  const pushed = [];
  const reactor = createAuthFlagReadsetReactor({
    materializations: [defineOrdersMaterialization()],
    sessions: [
      sessionEvent("session:alice", 1, "session.Started", {
        sessionId: "session-alice",
        principalId: "user:alice",
      }),
    ],
    events: [
      orderEvent("orders", 1, "order.Visible", {
        orderId: "order-1",
        owner: "user:alice",
        value: 42,
      }),
    ],
  });

  reactor.subscribe({
    subscriptionId: "sub:alice-orders",
    materialization: "visibleOrders",
    principal: { id: "user:alice", sessionId: "session-alice" },
    client: pushCollector(pushed),
  });

  const wakeReport = reactor.append(
    sessionEvent("session:alice", 2, "session.Revoked", {
      sessionId: "session-alice",
      principalId: "user:alice",
      reason: "sign-out-everywhere",
    }),
  );

  assert.deepEqual(wakeReport, {
    streamId: "session:alice",
    eventType: "session.Revoked",
    wokenSubscriptions: ["sub:alice-orders"],
  });
  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:alice-orders",
      decision: "deny",
      reason: "session-revoked",
      seq: { orders: 1, "session:alice": 2 },
      result: [],
    },
  ]);
});

test("flag.Changed re-pushes subscriptions whose materialization read the ruleset", () => {
  const pushed = [];
  const reactor = createAuthFlagReadsetReactor({
    materializations: [defineFlaggedOrdersMaterialization()],
    sessions: [
      sessionEvent("session:alice", 1, "session.Started", {
        sessionId: "session-alice",
        principalId: "user:alice",
      }),
    ],
    flags: [
      flagEvent("flag:show-vip-orders", 1, "flag.Defined", {
        key: "show-vip-orders",
        value: false,
      }),
    ],
    events: [
      orderEvent("orders", 1, "order.Visible", {
        orderId: "vip-1",
        owner: "user:alice",
        tier: "vip",
        value: 99,
      }),
    ],
  });

  reactor.subscribe({
    subscriptionId: "sub:alice-vip-orders",
    materialization: "flaggedOrders",
    principal: { id: "user:alice", sessionId: "session-alice" },
    client: pushCollector(pushed),
  });

  const wakeReport = reactor.append(
    flagEvent("flag:show-vip-orders", 2, "flag.Changed", {
      key: "show-vip-orders",
      value: true,
    }),
  );

  assert.deepEqual(wakeReport.wokenSubscriptions, ["sub:alice-vip-orders"]);
  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:alice-vip-orders",
      decision: "allow",
      seq: {
        "flag:show-vip-orders": 2,
        orders: 1,
        "session:alice": 1,
      },
      result: [{ id: "vip-1", value: 99 }],
    },
  ]);
});

test("flag.Changed that narrows targeting removes rows from already-open subscriptions", () => {
  const pushed = [];
  const reactor = createAuthFlagReadsetReactor({
    materializations: [defineFlaggedOrdersMaterialization()],
    sessions: [
      sessionEvent("session:alice", 1, "session.Started", {
        sessionId: "session-alice",
        principalId: "user:alice",
      }),
    ],
    flags: [
      flagEvent("flag:show-vip-orders", 1, "flag.Defined", {
        key: "show-vip-orders",
        value: true,
      }),
    ],
    events: [
      orderEvent("orders", 1, "order.Visible", {
        orderId: "vip-1",
        owner: "user:alice",
        tier: "vip",
        value: 99,
      }),
    ],
  });

  reactor.subscribe({
    subscriptionId: "sub:alice-vip-orders",
    materialization: "flaggedOrders",
    principal: { id: "user:alice", sessionId: "session-alice" },
    client: pushCollector(pushed),
  });

  const wakeReport = reactor.append(
    flagEvent("flag:show-vip-orders", 2, "flag.Changed", {
      key: "show-vip-orders",
      value: false,
    }),
  );

  assert.deepEqual(wakeReport.wokenSubscriptions, ["sub:alice-vip-orders"]);
  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:alice-vip-orders",
      decision: "allow",
      seq: {
        "flag:show-vip-orders": 2,
        orders: 1,
        "session:alice": 1,
      },
      result: [],
    },
  ]);
});

test("auth recompute fails closed instead of keeping privileged rows open", () => {
  const pushed = [];
  let authBackendFails = false;
  const reactor = createAuthFlagReadsetReactor({
    materializations: [definePrivilegedOrdersMaterialization({ authBackendFails: () => authBackendFails })],
    sessions: [
      sessionEvent("session:alice", 1, "session.Started", {
        sessionId: "session-alice",
        principalId: "user:alice",
      }),
    ],
    events: [
      orderEvent("orders", 1, "order.Visible", {
        orderId: "secret-1",
        owner: "user:alice",
        value: 4200,
      }),
    ],
  });

  reactor.subscribe({
    subscriptionId: "sub:alice-privileged",
    materialization: "privilegedOrders",
    principal: { id: "user:alice", sessionId: "session-alice" },
    client: pushCollector(pushed),
  });

  authBackendFails = true;
  reactor.append(
    sessionEvent("session:alice", 2, "session.Refreshed", {
      sessionId: "session-alice",
      principalId: "user:alice",
    }),
  );

  assert.deepEqual(pushed, [
    {
      type: "subscription.Pushed",
      subscriptionId: "sub:alice-privileged",
      decision: "deny",
      reason: "auth-recompute-failed",
      seq: { orders: 1, "session:alice": 2 },
      result: [],
    },
  ]);
});

test("materializations cannot hide flag dependencies outside the read-set", () => {
  const reactor = createAuthFlagReadsetReactor({
    materializations: [defineHiddenFlagDependencyMaterialization()],
    sessions: [
      sessionEvent("session:alice", 1, "session.Started", {
        sessionId: "session-alice",
        principalId: "user:alice",
      }),
    ],
    flags: [
      flagEvent("flag:show-vip-orders", 1, "flag.Defined", {
        key: "show-vip-orders",
        value: true,
      }),
    ],
    events: [
      orderEvent("orders", 1, "order.Visible", {
        orderId: "vip-1",
        owner: "user:alice",
        tier: "vip",
        value: 99,
      }),
    ],
  });

  assert.throws(
    () =>
      reactor.subscribe({
        subscriptionId: "sub:hidden-flag",
        materialization: "hiddenFlagDependency",
        principal: { id: "user:alice", sessionId: "session-alice" },
        client: pushCollector([]),
      }),
    /flag read missing readSet member: show-vip-orders/,
  );
});

test("cross-cutting auth and flag events leave unaffected subscriptions untouched", () => {
  const alicePushed = [];
  const bobPushed = [];
  const flaglessPushed = [];
  const reactor = createAuthFlagReadsetReactor({
    materializations: [defineOrdersMaterialization(), defineFlaggedOrdersMaterialization()],
    sessions: [
      sessionEvent("session:alice", 1, "session.Started", {
        sessionId: "session-alice",
        principalId: "user:alice",
      }),
      sessionEvent("session:bob", 1, "session.Started", {
        sessionId: "session-bob",
        principalId: "user:bob",
      }),
    ],
    flags: [
      flagEvent("flag:show-vip-orders", 1, "flag.Defined", {
        key: "show-vip-orders",
        value: false,
      }),
    ],
    events: [
      orderEvent("orders", 1, "order.Visible", {
        orderId: "alice-1",
        owner: "user:alice",
        tier: "vip",
        value: 10,
      }),
      orderEvent("orders", 2, "order.Visible", {
        orderId: "bob-1",
        owner: "user:bob",
        tier: "vip",
        value: 20,
      }),
    ],
  });

  reactor.subscribe({
    subscriptionId: "sub:alice-flagged",
    materialization: "flaggedOrders",
    principal: { id: "user:alice", sessionId: "session-alice" },
    client: pushCollector(alicePushed),
  });
  reactor.subscribe({
    subscriptionId: "sub:bob-orders",
    materialization: "visibleOrders",
    principal: { id: "user:bob", sessionId: "session-bob" },
    client: pushCollector(bobPushed),
  });
  reactor.subscribe({
    subscriptionId: "sub:alice-orders",
    materialization: "visibleOrders",
    principal: { id: "user:alice", sessionId: "session-alice" },
    client: pushCollector(flaglessPushed),
  });

  const flagWake = reactor.append(
    flagEvent("flag:show-vip-orders", 2, "flag.Changed", {
      key: "show-vip-orders",
      value: true,
    }),
  );
  const sessionWake = reactor.append(
    sessionEvent("session:alice", 2, "session.Revoked", {
      sessionId: "session-alice",
      principalId: "user:alice",
      reason: "admin-revoked-session",
    }),
  );

  assert.deepEqual(flagWake.wokenSubscriptions, ["sub:alice-flagged"]);
  assert.deepEqual(sessionWake.wokenSubscriptions, ["sub:alice-flagged", "sub:alice-orders"]);
  assert.equal(alicePushed.length, 2);
  assert.equal(flaglessPushed.length, 1);
  assert.deepEqual(bobPushed, []);
});

function defineOrdersMaterialization() {
  return defineMaterialization({
    name: "visibleOrders",
    readSet: [
      { kind: "eventType", value: "order.Visible" },
      { kind: "authState", value: "session" },
    ],
    initialState: [],
    fold(state, event, context) {
      if (event.type !== "order.Visible") {
        return state;
      }
      if (event.data.owner !== context.principal.id) {
        return state;
      }
      return [
        ...state,
        {
          id: event.data.orderId,
          value: event.data.value,
        },
      ];
    },
  });
}

function definePrivilegedOrdersMaterialization({ authBackendFails }) {
  return defineMaterialization({
    name: "privilegedOrders",
    readSet: [
      { kind: "eventType", value: "order.Visible" },
      { kind: "authState", value: "session" },
    ],
    initialState: [],
    authorize() {
      if (authBackendFails()) {
        throw new Error("policy cache unavailable");
      }
      return true;
    },
    fold(state, event, context) {
      if (event.type !== "order.Visible" || event.data.owner !== context.principal.id) {
        return state;
      }
      return [...state, { id: event.data.orderId, value: event.data.value }];
    },
  });
}

function defineFlaggedOrdersMaterialization() {
  return defineMaterialization({
    name: "flaggedOrders",
    readSet: [
      { kind: "eventType", value: "order.Visible" },
      { kind: "authState", value: "session" },
      { kind: "flagState", value: "show-vip-orders" },
    ],
    initialState: [],
    fold(state, event, context) {
      if (event.type !== "order.Visible") {
        return state;
      }
      if (!context.flag("show-vip-orders")) {
        return state;
      }
      if (event.data.owner !== context.principal.id || event.data.tier !== "vip") {
        return state;
      }
      return [...state, { id: event.data.orderId, value: event.data.value }];
    },
  });
}

function defineHiddenFlagDependencyMaterialization() {
  return defineMaterialization({
    name: "hiddenFlagDependency",
    readSet: [
      { kind: "eventType", value: "order.Visible" },
      { kind: "authState", value: "session" },
    ],
    initialState: [],
    fold(state, event, context) {
      if (event.type !== "order.Visible" || !context.flag("show-vip-orders")) {
        return state;
      }
      return [...state, { id: event.data.orderId, value: event.data.value }];
    },
  });
}

function orderEvent(streamId, seq, type, data) {
  return { streamId, seq, type, data };
}

function sessionEvent(streamId, seq, type, data) {
  return { streamId, seq, type, data };
}

function flagEvent(streamId, seq, type, data) {
  return { streamId, seq, type, data };
}

function pushCollector(events) {
  return {
    push(event) {
      events.push(event);
    },
  };
}
