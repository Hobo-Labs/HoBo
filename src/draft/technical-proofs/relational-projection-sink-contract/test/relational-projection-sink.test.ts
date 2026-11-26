import assert from "node:assert/strict";
import { test } from "vitest";

import {
  ProjectionSinkMappingError,
  createRelationalProjectionSink,
  defineRelationalProjection,
  mapRecordToPostgresSchema,
  normalizePostgresChangeFeed,
  realizeRelationalProjectionOverWasiSql,
  runRelationalSinkConformance,
} from "../src/relational-projection-sink.js";

test("relational sink maps WIT record fields into a Postgres table schema", () => {
  const projection = defineTicketProjection();

  assert.deepEqual(mapRecordToPostgresSchema(projection), {
    table: "support_ticket_view",
    columns: [
      { name: "comments", type: "integer", nullable: false },
      { name: "id", type: "text", nullable: false, primaryKey: true },
      { name: "status", type: "text", nullable: false, check: ["closed", "open"] },
      { name: "title", type: "text", nullable: false },
    ],
    indexes: [{ columns: ["status"], name: "support_ticket_view_status_idx" }],
  });
});

test("projection materializes into Postgres and emits ordered data.Changed", () => {
  const projection = defineTicketProjection();
  const sink = createRelationalProjectionSink(projection);

  sink.replay([
    ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
    ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open", title: "Login" }),
  ]);

  assert.deepEqual(sink.rows(), [
    {
      comments: 1,
      id: "ticket-1",
      status: "open",
      title: "Login",
    },
  ]);
  assert.deepEqual(sink.changeFeed(), [
    {
      key: "ticket-1",
      lsn: "0/00000001",
      op: "insert",
      resource: "postgres.projection.support_ticket_view",
      seq: 1,
      type: "data.Changed",
    },
    {
      key: "ticket-1",
      lsn: "0/00000002",
      op: "update",
      resource: "postgres.projection.support_ticket_view",
      seq: 2,
      type: "data.Changed",
    },
  ]);
});

test("change-feed reads are bounded-staleness, not read-your-writes", () => {
  const sink = createRelationalProjectionSink(defineTicketProjection());
  sink.replay([ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open", title: "Login" })]);

  assert.deepEqual(sink.read("ticket-1"), {
    consistency: "bounded-staleness",
    key: "ticket-1",
    seq: 1,
    value: {
      comments: 0,
      id: "ticket-1",
      status: "open",
      title: "Login",
    },
  });
});

test("cached sink serves point, find, and ordered reads with bounded-staleness", () => {
  const sink = createRelationalProjectionSink(defineTicketProjection());
  sink.replay([
    ticketEvent("ticket-2", 1, "ticket.Opened", { status: "open", title: "Billing" }),
    ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open", title: "Login" }),
    ticketEvent("ticket-3", 1, "ticket.Opened", { status: "closed", title: "Audit" }),
  ]);

  assert.deepEqual(sink.read("ticket-2").value, {
    comments: 0,
    id: "ticket-2",
    status: "open",
    title: "Billing",
  });
  assert.deepEqual(sink.query({ where: { status: "open" }, orderBy: [{ column: "title", direction: "asc" }] }), {
    consistency: "bounded-staleness",
    rows: [
      { comments: 0, id: "ticket-2", status: "open", title: "Billing" },
      { comments: 0, id: "ticket-1", status: "open", title: "Login" },
    ],
    seq: 1,
  });
});

test("drop and replay rebuilds identical relational state from the log", () => {
  const events = [
    ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open", title: "Login" }),
    ticketEvent("ticket-2", 1, "ticket.Opened", { status: "closed", title: "Billing" }),
    ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
  ];

  const original = createRelationalProjectionSink(defineTicketProjection());
  original.replay(events);

  const rebuilt = createRelationalProjectionSink(defineTicketProjection());
  rebuilt.replay(events);
  rebuilt.drop();
  rebuilt.replay(events);

  assert.deepEqual(rebuilt.rows(), original.rows());
  assert.deepEqual(rebuilt.schema(), original.schema());
});

test("relational sink conformance report covers mapping, change-feed, and rebuild", () => {
  const report = runRelationalSinkConformance({
    projection: defineTicketProjection(),
    events: [
      ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open", title: "Login" }),
      ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
    ],
  });

  assert.deepEqual(report, {
    pass: true,
    suite: "@hobo/conformance/projection-sink/relational-postgres",
    assertions: [
      "wit-record-mapped-to-columns",
      "wasi-sql-query-realization",
      "ordered-data-changed-emitted",
      "bounded-staleness-labeled",
      "cached-point-find-order-reads",
      "drop-and-replay-rebuilds-identical-state",
    ],
  });
});

test("relational mapping realizes over the pinned wasi:sql query interface", () => {
  assert.deepEqual(realizeRelationalProjectionOverWasiSql(defineTicketProjection()), {
    imports: ["wasi:sql/query@0.2.0"],
    statements: [
      "create table if not exists support_ticket_view (comments integer not null, id text not null primary key, status text not null check (status in ('closed', 'open')), title text not null)",
      "create index if not exists support_ticket_view_status_idx on support_ticket_view (status)",
    ],
  });
});

test("out-of-order logical replication changes are normalized to seq and LSN order", () => {
  assert.deepEqual(
    normalizePostgresChangeFeed([
      postgresChange("ticket-1", 3, "0/00000003", "update"),
      postgresChange("ticket-1", 1, "0/00000001", "insert"),
      postgresChange("ticket-1", 2, "0/00000002", "update"),
    ]),
    [
      {
        key: "ticket-1",
        lsn: "0/00000001",
        op: "insert",
        resource: "postgres.projection.support_ticket_view",
        seq: 1,
        type: "data.Changed",
      },
      {
        key: "ticket-1",
        lsn: "0/00000002",
        op: "update",
        resource: "postgres.projection.support_ticket_view",
        seq: 2,
        type: "data.Changed",
      },
      {
        key: "ticket-1",
        lsn: "0/00000003",
        op: "update",
        resource: "postgres.projection.support_ticket_view",
        seq: 3,
        type: "data.Changed",
      },
    ],
  );
});

test("enum values absent from the WIT enum fail mapping instead of coercing", () => {
  const sink = createRelationalProjectionSink(defineTicketProjection());

  assert.throws(
    () => sink.replay([ticketEvent("ticket-1", 1, "ticket.Opened", { status: "paused", title: "Login" })]),
    ProjectionSinkMappingError,
  );
});

test("non-text WIT scalar columns fail closed on wrong row value types", () => {
  const invalidRows = [
    { active: "true", revision: 1, score: 1.5 },
    { active: true, revision: "1", score: 1.5 },
    { active: true, revision: 1, score: "1.5" },
    { active: true, revision: 1, score: Number.NaN },
  ];

  const validSink = createRelationalProjectionSink(defineScalarProjection());
  validSink.replay([scalarEvent("metric-1", { active: true, revision: 1, score: 1.5 })]);

  assert.deepEqual(validSink.rows(), [{ active: true, id: "metric-1", revision: 1, score: 1.5 }]);

  for (const data of invalidRows) {
    const sink = createRelationalProjectionSink(defineScalarProjection());
    assert.throws(() => sink.replay([scalarEvent("metric-1", data)]), ProjectionSinkMappingError);
  }
});

test("custom index names are validated before SQL realization", () => {
  assert.throws(
    () =>
      defineRelationalProjection({
        ...ticketProjectionInput(),
        indexes: [{ columns: ["status"], name: "ticketStatusIdx" }],
      }),
    ProjectionSinkMappingError,
  );
});

function defineTicketProjection() {
  return defineRelationalProjection(ticketProjectionInput());
}

function ticketProjectionInput() {
  return {
    name: "support-tickets",
    readModel: "support:tickets/ticket-view@1.0.0",
    table: "support_ticket_view",
    key: (event) => event.streamId,
    initialState: { comments: 0, id: "", status: "open", title: "" },
    rowContract: {
      fields: [
        { name: "id", type: "string", primaryKey: true },
        { name: "title", type: "string" },
        { name: "status", type: "enum", values: ["open", "closed"] },
        { name: "comments", type: "u32" },
      ],
    },
    indexes: [{ columns: ["status"] }],
    on: {
      "ticket.Opened": (state, event) => ({
        ...state,
        id: event.streamId,
        status: event.data.status,
        title: event.data.title,
      }),
      "ticket.Commented": (state) => ({
        ...state,
        comments: state.comments + 1,
      }),
    },
  };
}

function defineScalarProjection() {
  return defineRelationalProjection({
    name: "scalar-metrics",
    readModel: "support:metrics/metric-view@1.0.0",
    table: "metric_view",
    key: (event) => event.streamId,
    rowContract: {
      fields: [
        { name: "id", type: "string", primaryKey: true },
        { name: "active", type: "bool" },
        { name: "revision", type: "u64" },
        { name: "score", type: "float64" },
      ],
    },
    on: {
      "metric.Observed": (_state, event) => ({
        id: event.streamId,
        active: event.data.active,
        revision: event.data.revision,
        score: event.data.score,
      }),
    },
  });
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

function scalarEvent(streamId, data) {
  return {
    id: `${streamId}-1`,
    streamId,
    seq: 1,
    type: "metric.Observed",
    data,
  };
}

function postgresChange(key, seq, lsn, op) {
  return {
    key,
    lsn,
    op,
    resource: "postgres.projection.support_ticket_view",
    seq,
  };
}
