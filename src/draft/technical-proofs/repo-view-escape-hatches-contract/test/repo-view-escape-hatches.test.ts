import assert from "node:assert/strict";
import { test } from "vitest";

import {
  and,
  createProjectionStore,
  eq,
  in as oneOf,
  repo,
  range,
  runDoctor,
  snapshot,
  tenantContext,
  useQuery,
  view,
} from "../src/repo-view-escape-hatches.js";

test("snapshot and repo.get read cached projection state by seq over any sink", () => {
  const rows = [
    ticket("t1", "tenant-a", 4, { status: "open", team: "infra", title: "Disk full" }),
    ticket("t2", "tenant-a", 2, { status: "closed", team: "infra", title: "Login fixed" }),
  ];
  const nativeTickets = createTickets({ sink: { type: "native", reactive: true }, rows });
  const postgresTickets = createTickets({ sink: { type: "postgres", reactive: true }, rows });
  const ctx = tenantContext("tenant-a");
  const appRead = (store) => repo(store, "tickets").get("t1", ctx);

  assert.deepEqual(snapshot(nativeTickets).seq, { "ticket:t1": 4, "ticket:t2": 2 });
  assert.equal(snapshot(nativeTickets).cache, "hit");
  assert.deepEqual(appRead(nativeTickets), appRead(postgresTickets));
  assert.deepEqual(appRead(nativeTickets).row, {
    id: "t1",
    seq: 4,
    status: "open",
    streamId: "ticket:t1",
    team: "infra",
    tenantId: "tenant-a",
    title: "Disk full",
  });
});

test("predicate DSL composes domain filters with platform tenant scope", () => {
  const store = createTickets({
    rows: [
      ticket("t1", "tenant-a", 1, { status: "open", team: "infra" }),
      ticket("t2", "tenant-a", 1, { status: "closed", team: "infra" }),
      ticket("t3", "tenant-b", 1, { status: "open", team: "infra" }),
    ],
  });
  const ctx = tenantContext("tenant-a");

  const found = repo(store, "tickets").find(and(eq("team", "infra"), eq("status", "open")), ctx);

  assert.deepEqual(found.rows.map((row) => row.id), ["t1"]);
  assert.deepEqual(found.appliedPredicate, {
    all: [
      { field: "team", op: "eq", value: "infra" },
      { field: "status", op: "eq", value: "open" },
      { field: "tenantId", op: "eq", value: "tenant-a", source: "platform" },
    ],
  });
});

test("useQuery sugar supports in and range predicates by logical projection name", () => {
  const store = createTickets({
    indexKeys: ["priority", "status", "team", "tenantId"],
    rows: [
      ticket("t1", "tenant-a", 1, { priority: 1, status: "open", team: "infra" }),
      ticket("t2", "tenant-a", 2, { priority: 2, status: "queued", team: "infra" }),
      ticket("t3", "tenant-a", 3, { priority: 4, status: "open", team: "infra" }),
      ticket("t4", "tenant-b", 4, { priority: 2, status: "queued", team: "infra" }),
    ],
  });
  const ctx = tenantContext("tenant-a");

  const found = useQuery(store, "tickets", ctx)
    .where(and(oneOf("status", ["open", "queued"]), range("priority", { gte: 2, lte: 3 })))
    .snapshot();

  assert.deepEqual(found.rows.map((row) => row.id), ["t2"]);
  assert.deepEqual(found.appliedPredicate, {
    all: [
      { field: "status", op: "in", values: ["open", "queued"] },
      { field: "priority", op: "range", gte: 2, lte: 3 },
      { field: "tenantId", op: "eq", value: "tenant-a", source: "platform" },
    ],
  });
  assert.throws(() => useQuery(store, "ticket_rows", ctx), /unknown projection: ticket_rows/);
});

test("tenant-scoped reads with no resolved tenant fail closed", () => {
  const store = createTickets({
    rows: [
      ticket("t1", "tenant-a", 1, { status: "open" }),
      ticket("t2", "tenant-b", 1, { status: "open" }),
    ],
  });

  assert.throws(() => repo(store, "tickets").find(eq("status", "open")), /tenant scope required/);
});

test("repo.find allows non-indexed predicates but hobo doctor flags the cost risk", () => {
  const store = createTickets({
    indexKeys: ["status", "tenantId"],
    rows: [ticket("t1", "tenant-a", 1, { status: "open", title: "Disk full" })],
  });

  const found = repo(store, "tickets").find(eq("title", "Disk full"), tenantContext("tenant-a"));

  assert.deepEqual(found.rows.map((row) => row.id), ["t1"]);
  assert.deepEqual(runDoctor(store).warnings, [
    {
      code: "NON_INDEXED_PREDICATE",
      field: "title",
      projection: "tickets",
      severity: "cost-risk",
    },
  ]);
});

test("cross-tenant predicates cannot bypass the platform tenant filter", () => {
  const store = createTickets({
    rows: [
      ticket("t1", "tenant-a", 1, { status: "open" }),
      ticket("t2", "tenant-b", 1, { status: "open" }),
    ],
  });

  assert.throws(
    () => repo(store, "tickets").find(eq("tenantId", "tenant-b"), tenantContext("tenant-a")),
    /cross-tenant predicate denied/,
  );
});

test("non-reactive sinks allow point reads but warn when used as a live view", () => {
  const store = createTickets({
    sink: { type: "mongo-archive", reactive: false },
    rows: [ticket("t1", "tenant-a", 7, { status: "open", team: "infra" })],
  });
  const ctx = tenantContext("tenant-a");

  assert.equal(repo(store, "tickets").get("t1", ctx).row.status, "open");
  assert.deepEqual(
    view(store, "tickets", ctx)
      .where(eq("status", "open"))
      .asLiveView()
      .rows.map((row) => row.id),
    ["t1"],
  );
  assert.deepEqual(runDoctor(store).warnings, [
    {
      code: "NON_REACTIVE_LIVE_VIEW",
      projection: "tickets",
      severity: "reactivity-risk",
      sink: "mongo-archive",
    },
  ]);
});

function createTickets({ sink = { type: "native", reactive: true }, indexKeys = ["status", "team", "tenantId"], rows }) {
  return createProjectionStore({
    name: "tickets",
    tenantScoped: true,
    sink,
    indexKeys,
    rows,
  });
}

function ticket(id, tenantId, seq, fields = {}) {
  return {
    id,
    streamId: `ticket:${id}`,
    seq,
    tenantId,
    ...fields,
  };
}
