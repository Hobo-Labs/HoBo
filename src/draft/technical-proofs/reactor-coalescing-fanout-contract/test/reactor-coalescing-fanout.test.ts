import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createCoalescingFanoutReactor,
  defineMaterialization,
  isSeqAtLeast,
} from "../src/reactor-coalescing-fanout.js";

test("fuzzed out-of-order appends preserve monotonic seq and canonical materialized value", () => {
  const canonical = replayWith(eventsInCanonicalOrder());
  const expected = canonical.snapshot("sub:documents").result;

  for (const shuffled of fuzzedArrivalOrders(eventsInCanonicalOrder())) {
    const pushed = [];
    const reactor = createDocumentReactor();
    reactor.subscribe({
      subscriptionId: "sub:documents",
      materialization: "documentList",
      client: pushCollector(pushed),
    });

    for (const event of shuffled) {
      reactor.append(event);
      reactor.drainAllFanout();
    }

    assert.equal(
      pushed.every((event, index, events) =>
        index === 0 || isSeqAtLeast(event.seq, events[index - 1].seq),
      ),
      true,
      `non-monotonic push sequence for arrival order ${shuffled.map((event) => event.id).join(",")}`,
    );
    assert.deepEqual(reactor.snapshot("sub:documents").result, expected);
  }
});

test("burst updates for a slow client coalesce to the latest seq without unbounded backlog", () => {
  const client = controllableClient({ ready: false });
  const reactor = createDocumentReactor({ maxFanoutPerTick: 2 });
  reactor.subscribe({
    subscriptionId: "sub:slow-document",
    materialization: "documentList",
    client,
  });

  for (let seq = 1; seq <= 10; seq += 1) {
    reactor.append(documentEvent({ seq, value: `v${seq}` }));
  }

  assert.equal(reactor.coalescedBacklogDepth("sub:slow-document"), 1);
  assert.equal(reactor.fanoutDepth().total, 1);

  const blocked = reactor.drainFanoutTick();
  assert.deepEqual(blocked.blocked, ["sub:slow-document"]);
  assert.equal(client.events.length, 0);
  assert.equal(reactor.coalescedBacklogDepth("sub:slow-document"), 1);

  reactor.append(documentEvent({ seq: 11, value: "v11" }));
  reactor.drainFanoutTick();
  assert.equal(reactor.coalescedBacklogDepth("sub:slow-document"), 1);

  client.setReady(true);
  reactor.resumeBlocked("sub:slow-document");
  reactor.drainFanoutTick();

  assert.equal(client.events.length, 1);
  assert.deepEqual(client.events[0].seq, { "doc:alpha": 11 });
  assert.deepEqual(client.events[0].result.documents, [{ id: "doc:alpha", value: "v11" }]);
  assert.equal(reactor.coalescedBacklogDepth("sub:slow-document"), 0);
});

test("global flag changes drain through a bounded sharded queue with no synchronous push spike", () => {
  const reactor = createDocumentReactor({ maxFanoutPerTick: 4, shardCount: 4 });
  const clients = new Map();

  for (let index = 0; index < 23; index += 1) {
    const subscriptionId = `sub:flag:${index.toString().padStart(2, "0")}`;
    const client = pushCollector([]);
    clients.set(subscriptionId, client);
    reactor.subscribe({
      subscriptionId,
      materialization: "documentList",
      client,
    });
  }

  const report = reactor.append(flagEvent({ seq: 1, enabled: true }));

  assert.equal(report.synchronousPushes, 0);
  assert.equal(report.enqueued, 23);
  assert.equal(reactor.fanoutDepth().total, 23);
  assert.equal([...clients.values()].flatMap((client) => client.events).length, 0);

  const drain = reactor.drainAllFanout({ maxTicks: 10 });

  assert.equal(drain.remaining, 0);
  assert.equal(drain.maxDeliveredPerTick <= 4, true);
  assert.equal(drain.ticks <= 6, true);
  assert.equal([...clients.values()].every((client) => client.events.length === 1), true);
});

test("session revocations use the same bounded cross-cutting fan-out path", () => {
  const reactor = createDocumentReactor({ maxFanoutPerTick: 2, shardCount: 2 });
  const clients = [];

  for (let index = 0; index < 5; index += 1) {
    const client = pushCollector([]);
    clients.push(client);
    reactor.subscribe({
      subscriptionId: `sub:session:${index}`,
      materialization: "documentList",
      client,
    });
  }

  const report = reactor.append(sessionRevokedEvent({ seq: 1, sessionId: "session-a" }));
  const firstTick = reactor.drainFanoutTick();
  const drain = reactor.drainAllFanout();

  assert.equal(report.synchronousPushes, 0);
  assert.equal(report.enqueued, 5);
  assert.equal(firstTick.delivered.length <= 2, true);
  assert.equal(drain.remaining, 0);
  assert.equal(
    clients.every((client) => client.events.at(-1).result.revokedSessions.includes("session-a")),
    true,
  );
});

test("global fan-out preserves per-subscription ordering across repeated flips", () => {
  const reactor = createDocumentReactor({ maxFanoutPerTick: 3, shardCount: 3 });
  const clients = [];

  for (let index = 0; index < 9; index += 1) {
    const client = pushCollector([]);
    clients.push(client);
    reactor.subscribe({
      subscriptionId: `sub:ordered:${index}`,
      materialization: "documentList",
      client,
    });
  }

  reactor.append(flagEvent({ seq: 1, enabled: true }));
  reactor.drainAllFanout();
  reactor.append(flagEvent({ seq: 2, enabled: false }));
  reactor.drainAllFanout();

  for (const client of clients) {
    assert.deepEqual(
      client.events.map((event) => event.seq),
      [{ "flag:beta": 1 }, { "flag:beta": 2 }],
    );
  }
});

test("duplicate event ids are idempotent and do not double-apply", () => {
  const pushed = [];
  const reactor = createDocumentReactor();
  reactor.subscribe({
    subscriptionId: "sub:counts",
    materialization: "countedDocuments",
    client: pushCollector(pushed),
  });
  const event = {
    id: "01J00000000000000000000020",
    ulid: "01J00000000000000000000020",
    streamId: "doc:counter",
    seq: 1,
    type: "document.Counted",
    data: { amount: 1 },
  };

  reactor.append(event);
  reactor.drainAllFanout();
  const duplicate = reactor.append(event);
  reactor.drainAllFanout();

  assert.equal(duplicate.duplicate, true);
  assert.equal(pushed.length, 1);
  assert.deepEqual(reactor.snapshot("sub:counts").result, { count: 1 });
});

test("local subscription work does not starve behind a large global fan-out", () => {
  const localClient = pushCollector([]);
  const reactor = createDocumentReactor({ maxFanoutPerTick: 3, shardCount: 3 });

  for (let index = 0; index < 18; index += 1) {
    reactor.subscribe({
      subscriptionId: `sub:global:${index}`,
      materialization: "flagOnly",
      client: pushCollector([]),
    });
  }
  reactor.subscribe({
    subscriptionId: "sub:local",
    materialization: "singleDocument",
    args: { streamId: "doc:urgent" },
    client: localClient,
  });

  reactor.append(flagEvent({ seq: 1, enabled: true }));
  assert.equal(reactor.fanoutDepth().crossCutting > 0, true);

  reactor.append(documentEvent({ streamId: "doc:urgent", seq: 1, value: "urgent" }));
  const firstTick = reactor.drainFanoutTick();

  assert.equal(firstTick.delivered.includes("sub:local"), true);
  assert.deepEqual(localClient.events.at(-1).result, { id: "doc:urgent", value: "urgent" });
  assert.equal(reactor.fanoutDepth().crossCutting > 0, true);
});

function createDocumentReactor(options = {}) {
  return createCoalescingFanoutReactor({
    ...options,
    materializations: [
      defineDocumentListMaterialization(),
      defineCountedDocumentsMaterialization(),
      defineFlagOnlyMaterialization(),
      defineSingleDocumentMaterialization(),
    ],
  });
}

function replayWith(events) {
  const reactor = createDocumentReactor();
  reactor.subscribe({
    subscriptionId: "sub:documents",
    materialization: "documentList",
    client: pushCollector([]),
  });
  for (const event of events) {
    reactor.append(event);
    reactor.drainAllFanout();
  }
  return reactor;
}

function defineDocumentListMaterialization() {
  return defineMaterialization({
    name: "documentList",
    readSet: [
      { kind: "eventType", value: "document.Updated" },
      { kind: "eventType", value: "flag.Changed" },
      { kind: "eventType", value: "session.Revoked" },
    ],
    initialState: { documents: [], flags: {}, revokedSessions: [] },
    fold(state, event) {
      if (event.type === "document.Updated") {
        return {
          ...state,
          documents: upsertDocument(state.documents, {
            id: event.streamId,
            value: event.data.value,
          }),
        };
      }

      if (event.type === "flag.Changed") {
        return {
          ...state,
          flags: {
            ...state.flags,
            [event.data.key]: event.data.enabled,
          },
        };
      }

      if (event.type === "session.Revoked") {
        return {
          ...state,
          revokedSessions: [...new Set([...state.revokedSessions, event.data.sessionId])].sort(),
        };
      }

      return state;
    },
    project(state) {
      return {
        documents: state.documents,
        flags: Object.fromEntries(Object.entries(state.flags).sort(([left], [right]) => left.localeCompare(right))),
        revokedSessions: state.revokedSessions,
      };
    },
  });
}

function defineCountedDocumentsMaterialization() {
  return defineMaterialization({
    name: "countedDocuments",
    readSet: [{ kind: "eventType", value: "document.Counted" }],
    initialState: { count: 0 },
    fold(state, event) {
      return { count: state.count + event.data.amount };
    },
  });
}

function defineFlagOnlyMaterialization() {
  return defineMaterialization({
    name: "flagOnly",
    readSet: [{ kind: "eventType", value: "flag.Changed" }],
    initialState: {},
    fold(state, event) {
      return {
        ...state,
        [event.data.key]: event.data.enabled,
      };
    },
  });
}

function defineSingleDocumentMaterialization() {
  return defineMaterialization({
    name: "singleDocument",
    readSet: [{ kind: "eventType", value: "document.Updated" }],
    initialState: null,
    fold(state, event, args) {
      if (event.streamId !== args.streamId) {
        return state;
      }
      return { id: event.streamId, value: event.data.value };
    },
  });
}

function eventsInCanonicalOrder() {
  return [
    documentEvent({
      id: "01J00000000000000000000001",
      ulid: "01J00000000000000000000001",
      streamId: "doc:alpha",
      seq: 1,
      value: "draft",
    }),
    documentEvent({
      id: "01J00000000000000000000002",
      ulid: "01J00000000000000000000002",
      streamId: "doc:beta",
      seq: 1,
      value: "queued",
    }),
    documentEvent({
      id: "01J00000000000000000000003",
      ulid: "01J00000000000000000000003",
      causationId: "01J00000000000000000000001",
      streamId: "doc:alpha",
      seq: 2,
      value: "review",
    }),
    documentEvent({
      id: "01J00000000000000000000004",
      ulid: "01J00000000000000000000004",
      causationId: "01J00000000000000000000003",
      streamId: "doc:alpha",
      seq: 3,
      value: "shipped",
    }),
  ];
}

function fuzzedArrivalOrders(events) {
  return [
    events,
    [events[2], events[0], events[3], events[1]],
    [events[3], events[1], events[2], events[0]],
    [events[1], events[3], events[0], events[2]],
  ];
}

function documentEvent(input) {
  const { causationId, streamId = "doc:alpha", seq, value } = input;
  const id = input.id ?? `01J00000000000000000000${String(seq).padStart(3, "0")}`;
  const ulid = input.ulid ?? id;
  return {
    id,
    ulid,
    causationId,
    streamId,
    seq,
    type: "document.Updated",
    data: { value },
  };
}

function flagEvent({ seq, enabled }) {
  return {
    id: `01J00000000000000000001${String(seq).padStart(3, "0")}`,
    ulid: `01J00000000000000000001${String(seq).padStart(3, "0")}`,
    streamId: "flag:beta",
    seq,
    type: "flag.Changed",
    data: { key: "beta", enabled },
  };
}

function sessionRevokedEvent({ seq, sessionId }) {
  return {
    id: `01J00000000000000000002${String(seq).padStart(3, "0")}`,
    ulid: `01J00000000000000000002${String(seq).padStart(3, "0")}`,
    streamId: `session:${sessionId}`,
    seq,
    type: "session.Revoked",
    data: { sessionId },
  };
}

function upsertDocument(documents, document) {
  const withoutCurrent = documents.filter((row) => row.id !== document.id);
  return [...withoutCurrent, document].sort((left, right) => left.id.localeCompare(right.id));
}

function pushCollector(events) {
  return {
    events,
    push(event) {
      events.push(event);
    },
  };
}

function controllableClient({ ready }) {
  let isReady = ready;
  const client = pushCollector([]);
  return {
    events: client.events,
    canAccept() {
      return isReady;
    },
    setReady(nextReady) {
      isReady = nextReady;
    },
    push: client.push,
  };
}
