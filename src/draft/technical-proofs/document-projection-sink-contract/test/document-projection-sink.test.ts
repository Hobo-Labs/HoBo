import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createRelationalProjectionSink,
  defineRelationalProjection,
} from "../../relational-projection-sink-contract/src/relational-projection-sink.js";
import {
  ProjectionSinkMappingError,
  createDocumentProjectionSink,
  defineDocumentProjection,
  mapRecordToMongoDocumentSchema,
  normalizeMongoChangeStream,
  realizeDocumentProjectionOverWasiKeyvalue,
  runDocumentSinkConformance,
} from "../src/document-projection-sink.js";

test("document sink maps WIT record fields into a Mongo document schema", () => {
  const projection = defineTicketDocumentProjection();

  assert.deepEqual(mapRecordToMongoDocumentSchema(projection), {
    collection: "support_ticket_docs",
    documentKey: "id",
    fields: [
      { name: "comments", path: "comments", required: true, type: "number" },
      { documentKey: true, name: "id", path: "_id", required: true, type: "string" },
      {
        fields: [
          { name: "name", path: "reporter.name", required: true, type: "string" },
          {
            enum: ["free", "pro"],
            name: "tier",
            path: "reporter.tier",
            required: true,
            type: "string",
          },
        ],
        name: "reporter",
        path: "reporter",
        required: true,
        type: "document",
      },
      { enum: ["closed", "open"], name: "status", path: "status", required: true, type: "string" },
      { name: "title", path: "title", required: true, type: "string" },
    ],
    indexes: [{ fields: ["status"], name: "support_ticket_docs_status_idx" }],
  });
});

test("projection materializes into Mongo documents and emits ordered data.Changed", () => {
  const sink = createDocumentProjectionSink(defineTicketDocumentProjection());

  sink.replay([
    ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
    ticketEvent("ticket-1", 1, "ticket.Opened", {
      reporter: { name: "Asha", tier: "pro" },
      status: "open",
      title: "Login",
    }),
  ]);

  assert.deepEqual(sink.documents(), [
    {
      _id: "ticket-1",
      comments: 1,
      reporter: { name: "Asha", tier: "pro" },
      status: "open",
      title: "Login",
    },
  ]);
  assert.deepEqual(sink.changeFeed(), [
    {
      key: "ticket-1",
      op: "insert",
      resource: "mongo.projection.support_ticket_docs",
      resumeToken: "0000000001",
      seq: 1,
      type: "data.Changed",
    },
    {
      key: "ticket-1",
      op: "update",
      resource: "mongo.projection.support_ticket_docs",
      resumeToken: "0000000002",
      seq: 2,
      type: "data.Changed",
    },
  ]);
});

test("same portable repo/view query resolves byte-identically over native, Postgres, and Mongo", () => {
  const events = [
    ticketEvent("ticket-2", 1, "ticket.Opened", { status: "open", title: "Billing" }),
    ticketEvent("ticket-1", 1, "ticket.Opened", { status: "open", title: "Login" }),
    ticketEvent("ticket-3", 1, "ticket.Opened", { status: "closed", title: "Audit" }),
  ];
  const relational = createRelationalProjectionSink(defineTicketRelationalProjection()).replay(events);
  const document = createDocumentProjectionSink(defineTicketFlatDocumentProjection()).replay(events);
  const nativeRows = [
    { comments: 0, id: "ticket-2", status: "open", title: "Billing" },
    { comments: 0, id: "ticket-1", status: "open", title: "Login" },
  ];

  assert.deepEqual(
    relational.query({ where: { status: "open" }, orderBy: [{ column: "title" }] }).rows,
    nativeRows,
  );
  assert.deepEqual(
    document.query({ where: { status: "open" }, orderBy: [{ field: "title" }] }).rows,
    nativeRows,
  );
});

test("drop and replay rebuilds identical document state from the log", () => {
  const events = [
    ticketEvent("ticket-1", 1, "ticket.Opened", {
      reporter: { name: "Asha", tier: "pro" },
      status: "open",
      title: "Login",
    }),
    ticketEvent("ticket-2", 1, "ticket.Opened", {
      reporter: { name: "Mina", tier: "free" },
      status: "closed",
      title: "Billing",
    }),
    ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
  ];

  const original = createDocumentProjectionSink(defineTicketDocumentProjection()).replay(events);
  const rebuilt = createDocumentProjectionSink(defineTicketDocumentProjection()).replay(events).drop().replay(events);

  assert.deepEqual(rebuilt.documents(), original.documents());
  assert.deepEqual(rebuilt.schema(), original.schema());
});

test("document sink conformance report covers mapping, change-feed, reads, and rebuild", () => {
  const report = runDocumentSinkConformance({
    projection: defineTicketDocumentProjection(),
    events: [
      ticketEvent("ticket-1", 1, "ticket.Opened", {
        reporter: { name: "Asha", tier: "pro" },
        status: "open",
        title: "Login",
      }),
      ticketEvent("ticket-1", 2, "ticket.Commented", { comment: "first" }),
    ],
  });

  assert.deepEqual(report, {
    pass: true,
    suite: "@hobo/conformance/projection-sink/document-mongo",
    assertions: [
      "wit-record-mapped-to-documents",
      "wasi-keyvalue-document-realization",
      "ordered-data-changed-emitted",
      "bounded-staleness-labeled",
      "cached-point-find-order-reads",
      "drop-and-replay-rebuilds-identical-state",
    ],
  });
});

test("document mapping realizes over the pinned wasi:keyvalue store interface", () => {
  assert.deepEqual(realizeDocumentProjectionOverWasiKeyvalue(defineTicketDocumentProjection()), {
    collection: "support_ticket_docs",
    imports: ["wasi:keyvalue/store@0.2.0"],
    indexes: [{ fields: ["status"], name: "support_ticket_docs_status_idx" }],
  });
});

test("out-of-order Mongo change-stream events are normalized to seq and resume-token order", () => {
  assert.deepEqual(
    normalizeMongoChangeStream([
      mongoChange("ticket-1", 3, "0000000003", "update"),
      mongoChange("ticket-1", 1, "0000000001", "insert"),
      mongoChange("ticket-1", 2, "0000000002", "replace"),
    ]),
    [
      {
        key: "ticket-1",
        op: "insert",
        resource: "mongo.projection.support_ticket_docs",
        resumeToken: "0000000001",
        seq: 1,
        type: "data.Changed",
      },
      {
        key: "ticket-1",
        op: "update",
        resource: "mongo.projection.support_ticket_docs",
        resumeToken: "0000000002",
        seq: 2,
        type: "data.Changed",
      },
      {
        key: "ticket-1",
        op: "update",
        resource: "mongo.projection.support_ticket_docs",
        resumeToken: "0000000003",
        seq: 3,
        type: "data.Changed",
      },
    ],
  );
});

test("portable DSL rejects cross-document joins instead of silently doing N+1 reads", () => {
  const sink = createDocumentProjectionSink(defineTicketDocumentProjection()).replay([
    ticketEvent("ticket-1", 1, "ticket.Opened", {
      reporter: { name: "Asha", tier: "pro" },
      status: "open",
      title: "Login",
    }),
  ]);

  assert.throws(
    () => sink.query({ join: { from: "users", localField: "reporter.name", foreignField: "name" } }),
    ProjectionSinkMappingError,
  );
});

test("deeply nested WIT records round-trip without field loss", () => {
  const sink = createDocumentProjectionSink(defineNestedDocumentProjection());

  sink.replay([
    {
      id: "invoice-1-1",
      streamId: "invoice-1",
      seq: 1,
      type: "invoice.Recorded",
      data: {
        customer: {
          address: {
            city: "Austin",
            postalCode: "78701",
          },
          name: "Asha",
        },
        total: 42,
      },
    },
  ]);

  assert.deepEqual(sink.documents(), [
    {
      _id: "invoice-1",
      customer: {
        address: {
          city: "Austin",
          postalCode: "78701",
        },
        name: "Asha",
      },
      total: 42,
    },
  ]);
});

test("enum values absent from the WIT enum fail mapping instead of coercing", () => {
  const sink = createDocumentProjectionSink(defineTicketDocumentProjection());

  assert.throws(
    () =>
      sink.replay([
        ticketEvent("ticket-1", 1, "ticket.Opened", {
          reporter: { name: "Asha", tier: "enterprise" },
          status: "open",
          title: "Login",
        }),
      ]),
    ProjectionSinkMappingError,
  );
});

function defineTicketDocumentProjection() {
  return defineDocumentProjection(ticketDocumentProjectionInput());
}

function defineTicketFlatDocumentProjection() {
  return defineDocumentProjection({
    ...ticketDocumentProjectionInput(),
    rowContract: {
      fields: [
        { name: "id", type: "string", primaryKey: true },
        { name: "title", type: "string" },
        { name: "status", type: "enum", values: ["open", "closed"] },
        { name: "comments", type: "u32" },
      ],
    },
    on: ticketHandlers(),
  });
}

function defineTicketRelationalProjection() {
  return defineRelationalProjection({
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
    on: ticketHandlers(),
  });
}

function ticketDocumentProjectionInput() {
  return {
    name: "support-tickets",
    readModel: "support:tickets/ticket-view@1.0.0",
    collection: "support_ticket_docs",
    key: (event) => event.streamId,
    initialState: {
      comments: 0,
      id: "",
      reporter: { name: "", tier: "free" },
      status: "open",
      title: "",
    },
    rowContract: {
      fields: [
        { name: "id", type: "string", primaryKey: true },
        { name: "title", type: "string" },
        { name: "status", type: "enum", values: ["open", "closed"] },
        {
          name: "reporter",
          type: "record",
          fields: [
            { name: "name", type: "string" },
            { name: "tier", type: "enum", values: ["free", "pro"] },
          ],
        },
        { name: "comments", type: "u32" },
      ],
    },
    indexes: [{ fields: ["status"] }],
    on: {
      "ticket.Opened": (state, event) => ({
        ...state,
        id: event.streamId,
        reporter: event.data.reporter ?? state.reporter,
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

function defineNestedDocumentProjection() {
  return defineDocumentProjection({
    name: "invoices",
    readModel: "billing:invoices/invoice-view@1.0.0",
    collection: "invoice_docs",
    key: (event) => event.streamId,
    rowContract: {
      fields: [
        { name: "id", type: "string", primaryKey: true },
        { name: "total", type: "u32" },
        {
          name: "customer",
          type: "record",
          fields: [
            { name: "name", type: "string" },
            {
              name: "address",
              type: "record",
              fields: [
                { name: "city", type: "string" },
                { name: "postalCode", type: "string" },
              ],
            },
          ],
        },
      ],
    },
    on: {
      "invoice.Recorded": (_state, event) => ({
        id: event.streamId,
        customer: event.data.customer,
        total: event.data.total,
      }),
    },
  });
}

function ticketHandlers() {
  return {
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

function mongoChange(key, seq, resumeToken, operationType) {
  return {
    key,
    operationType,
    resource: "mongo.projection.support_ticket_docs",
    resumeToken,
    seq,
  };
}
