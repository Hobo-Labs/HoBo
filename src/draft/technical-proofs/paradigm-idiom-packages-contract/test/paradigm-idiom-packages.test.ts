import assert from "node:assert/strict";
import { test } from "vitest";
import {
  ParadigmPackageContractError,
  assertThinParadigmPackage,
  buildParadigmPortabilityReport,
  defineDocumentProjection,
  defineGenericDataProjection,
  defineSqlProjection,
  lowerParadigmProjection,
  runParadigmPackageConformance,
  validateParadigmRemodel,
} from "../src/paradigm-idiom-packages.js";

const orderSchema = Object.freeze({
  name: "OrderReadModel",
  version: "1.0.0",
  wit: Object.freeze({
    package: "hobo:domain/orders@1.0.0",
    interface: "read-models",
    record: "OrderReadModel",
  }),
  fields: Object.freeze([
    Object.freeze({ name: "id", type: "string", primaryKey: true }),
    Object.freeze({ name: "customer_id", type: "string" }),
    Object.freeze({ name: "status", type: "enum", values: Object.freeze(["created", "paid"]) }),
    Object.freeze({ name: "total_cents", type: "u64" }),
  ]),
});

const orderEvents = Object.freeze([
  Object.freeze({
    streamId: "order-2",
    seq: 2,
    type: "order.paid",
    data: Object.freeze({ id: "order-2", customer_id: "cust-b", total_cents: 4200 }),
  }),
  Object.freeze({
    streamId: "order-1",
    seq: 1,
    type: "order.created",
    data: Object.freeze({ id: "order-1", customer_id: "cust-a", total_cents: 1200 }),
  }),
  Object.freeze({
    streamId: "order-2",
    seq: 1,
    type: "order.created",
    data: Object.freeze({ id: "order-2", customer_id: "cust-b", total_cents: 4200 }),
  }),
]);

const orderHandlers = Object.freeze({
  "order.created": (_previous, event) => ({
    id: event.data.id,
    customer_id: event.data.customer_id,
    status: "created",
    total_cents: event.data.total_cents,
  }),
  "order.paid": (previous, event) => ({
    ...previous,
    id: event.data.id,
    customer_id: event.data.customer_id,
    status: "paid",
    total_cents: event.data.total_cents,
  }),
});

function genericRelationalOrders() {
  return defineGenericDataProjection({
    name: "orders_by_customer",
    readModel: "OrderReadModel",
    schema: orderSchema,
    target: {
      paradigm: "relational",
      resourceName: "orders_by_customer",
      keyField: "id",
      indexes: [{ fields: ["customer_id"], name: "orders_by_customer_customer_idx" }],
    },
    consistency: "bounded-staleness",
    initialState: { id: "", customer_id: "", status: "created", total_cents: 0 },
    on: orderHandlers,
  });
}

function sqlOrders(overrides = {}) {
  return defineSqlProjection({
    name: "orders_by_customer",
    readModel: "OrderReadModel",
    schema: orderSchema,
    table: "orders_by_customer",
    keyField: "id",
    indexes: [{ fields: ["customer_id"], name: "orders_by_customer_customer_idx" }],
    consistency: "bounded-staleness",
    initialState: { id: "", customer_id: "", status: "created", total_cents: 0 },
    on: orderHandlers,
    ...overrides,
  });
}

function genericDocumentOrders() {
  return defineGenericDataProjection({
    name: "orders_document",
    readModel: "OrderReadModel",
    schema: orderSchema,
    target: {
      paradigm: "document",
      resourceName: "orders_document",
      keyField: "id",
      indexes: [{ fields: ["customer_id"], name: "orders_document_customer_idx" }],
    },
    consistency: "bounded-staleness",
    initialState: { id: "", customer_id: "", status: "created", total_cents: 0 },
    on: orderHandlers,
  });
}

function documentOrders(overrides = {}) {
  return defineDocumentProjection({
    name: "orders_document",
    readModel: "OrderReadModel",
    schema: orderSchema,
    collection: "orders_document",
    keyField: "id",
    indexes: [{ fields: ["customer_id"], name: "orders_document_customer_idx" }],
    consistency: "bounded-staleness",
    initialState: { id: "", customer_id: "", status: "created", total_cents: 0 },
    on: orderHandlers,
    ...overrides,
  });
}

test("@hobo/sql lowers to byte-identical hobo:projection calls and manifest IR as generic data", () => {
  const generic = lowerParadigmProjection(genericRelationalOrders());
  const sql = lowerParadigmProjection(sqlOrders());

  assert.deepEqual(sql.witCalls, generic.witCalls);
  assert.deepEqual(sql.manifestIr, generic.manifestIr);
  assert.deepEqual(sql.idiomMetadata, {
    packageName: "@hobo/sql",
    paradigm: "relational",
    port: "hobo:projection",
    thinLayer: true,
  });
  assert.equal(sql.manifestIr.resources[0].idiomPackage, undefined);
});

test("@hobo/document lowers to byte-identical hobo:projection calls and manifest IR as generic data", () => {
  const generic = lowerParadigmProjection(genericDocumentOrders());
  const document = lowerParadigmProjection(documentOrders());

  assert.deepEqual(document.witCalls, generic.witCalls);
  assert.deepEqual(document.manifestIr, generic.manifestIr);
  assert.deepEqual(document.idiomMetadata, {
    packageName: "@hobo/document",
    paradigm: "document",
    port: "hobo:projection",
    thinLayer: true,
  });
});

test("paradigm package native pins surface PortabilityReport debt", () => {
  const portablePostgres = buildParadigmPortabilityReport(sqlOrders());
  assert.deepEqual(portablePostgres.entries, []);
  assert.equal(portablePostgres.claim.portableWithin, "managed-postgres");

  const azureSql = sqlOrders({
    withNative: {
      provider: "azure",
      engineClass: "sql-server",
      service: "azure-sql-database",
      source: ".with",
    },
  });

  const report = buildParadigmPortabilityReport(azureSql);
  assert.equal(report.entries.length, 1);
  assert.deepEqual(report.entries[0], {
    id: "orders_by_customer.native-pin.azure.sql-server",
    category: "paradigm-native-pin",
    severity: "target-scoped",
    packageName: "@hobo/sql",
    resourceId: "orders_by_customer",
    source: ".with",
    provider: "azure",
    engineClass: "sql-server",
    service: "azure-sql-database",
    portability: "forfeited-within-class",
    portableWithin: "managed-postgres",
    gateEffect: "report-debt",
    detail: "SQL Server is a separate pin-only engine class, not part of the managed-Postgres portability claim.",
  });

  const dynamoDocument = documentOrders({
    resourceDefinitionNative: {
      provider: "aws",
      engineClass: "dynamodb-document",
      service: "dynamodb",
    },
  });
  const documentReport = buildParadigmPortabilityReport(dynamoDocument);

  assert.deepEqual(documentReport.entries, [
    {
      id: "orders_document.native-pin.aws.dynamodb-document",
      category: "paradigm-native-pin",
      severity: "target-scoped",
      packageName: "@hobo/document",
      resourceId: "orders_document",
      source: "resource-definition",
      provider: "aws",
      engineClass: "dynamodb-document",
      service: "dynamodb",
      portability: "forfeited-within-class",
      portableWithin: "document-store",
      gateEffect: "report-debt",
      detail:
        "dynamodb-document is a separate pin-only engine class, not part of the document-store portability claim.",
    },
  ]);
});

test("package and native adapter conformance round-trip fixtures and keep consistency labels", () => {
  const report = runParadigmPackageConformance({
    declarations: [sqlOrders(), documentOrders()],
    events: orderEvents,
  });

  assert.equal(report.status, "passed");
  assert.deepEqual(
    report.cases.map((entry) => [entry.packageName, entry.nativeAdapter, entry.status, entry.consistency]),
    [
      ["@hobo/sql", "aws.rds-postgres", "passed", "bounded-staleness"],
      ["@hobo/document", "mongodb.atlas", "passed", "bounded-staleness"],
    ],
  );
  assert.deepEqual(report.cases[0].rows, [
    { id: "order-1", customer_id: "cust-a", status: "created", total_cents: 1200 },
    { id: "order-2", customer_id: "cust-b", status: "paid", total_cents: 4200 },
  ]);
});

test("thin-SDK gate rejects cloud logic smuggled into a paradigm package", () => {
  assert.deepEqual(
    assertThinParadigmPackage([
      {
        path: "src/sql.ts",
        source: 'import { defineSqlProjection } from "@hobo/sql";\nexport const orders = true;',
      },
    ]),
    [],
  );

  const violations = assertThinParadigmPackage([
    {
      path: "src/sql.ts",
      source:
        'import { RDSClient } from "@aws-sdk/client-rds";\nexport function realize() { return new RDSClient({}); }',
    },
  ]);

  assert.deepEqual(violations, [
    {
      path: "src/sql.ts",
      reason: "cloud/provider runtime import is not allowed in the paradigm package",
      match: "@aws-sdk/client-rds",
    },
    {
      path: "src/sql.ts",
      reason: "provider realization logic is not allowed in the paradigm package",
      match: "realize(",
    },
  ]);

  assert.deepEqual(
    assertThinParadigmPackage([
      {
        path: "src/dynamic.ts",
        source: 'export async function connect() { return import("@azure/cosmos"); }',
      },
    ]),
    [
      {
        path: "src/dynamic.ts",
        reason: "cloud/provider runtime import is not allowed in the paradigm package",
        match: "@azure/cosmos",
      },
    ],
  );
});

test("cross-paradigm swaps reuse WIT type only with explicit remodel mapping", () => {
  const sql = sqlOrders();
  const document = documentOrders();

  assert.throws(
    () => validateParadigmRemodel({ from: sql, to: document }),
    (error) => {
      assert.ok(error instanceof ParadigmPackageContractError);
      assert.equal(error.code, "cross-paradigm-remodel-required");
      assert.match(error.message, /requires an explicit mapping/);
      return true;
    },
  );

  assert.equal(
    validateParadigmRemodel({
      from: sql,
      to: document,
      mapping: {
        reason: "model document read path separately",
        fields: { id: "_id", customer_id: "customer_id", status: "status", total_cents: "total_cents" },
      },
    }).status,
    "accepted",
  );
});

test("projection schemas must carry canonical WIT identity", () => {
  assert.throws(
    () =>
      defineSqlProjection({
        name: "orders_by_customer",
        readModel: "OrderReadModel",
        schema: {
          name: "OrderReadModel",
          fields: [{ name: "id", type: "string", primaryKey: true }],
        },
        table: "orders_by_customer",
        keyField: "id",
        on: {
          "order.created": (_previous, event) => ({ id: event.data.id }),
        },
      }),
    (error) => {
      assert.ok(error instanceof ParadigmPackageContractError);
      assert.equal(error.code, "canonical-wit-schema-required");
      return true;
    },
  );
});
