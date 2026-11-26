import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CONTRACT_EDGE_KINDS,
  CONTRACT_MODES,
  CONTRACT_SCHEMA,
  canonicalJson,
  createContractFixture,
  deserializeContract,
  exportAsyncApiContract,
  exportOpenApiContract,
  exportPactContract,
  exportProtobufContract,
  importAsyncApiContract,
  importOpenApiContract,
  importPactContract,
  importProtobufContract,
  parseContract,
  serializeContract
} from "../src/contract-ir.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("Contract IR validates and round-trips one fixture per graph edge kind", () => {
  for (const edgeKind of CONTRACT_EDGE_KINDS) {
    const contract = createContractFixture({ edgeKind });
    const parsed = parseContract(contract);

    assert.equal(parsed.ok, true, parsed.errors.join("\n"));
    assert.equal(parsed.contract.edge.kind, edgeKind);
    assert.equal(serializeContract(parsed.contract), canonicalJson(parsed.contract));
    assert.deepEqual(
      deserializeContract(serializeContract(parsed.contract)).contract,
      parsed.contract
    );
  }
});

test("schema and TypeScript declarations publish the contract surface", async () => {
  const schemaText = await readFile(
    path.join(packageRoot, "schema", "contract.ir.v1.schema.json"),
    "utf8"
  );
  const declarations = await readFile(
    path.join(packageRoot, "src", "contract-ir.d.ts"),
    "utf8"
  );

  const schema = JSON.parse(schemaText);
  assert.equal(schema.$id, "https://schemas.hobo.dev/contract.ir.v1.schema.json");
  assert.equal(CONTRACT_SCHEMA, "contract.ir/v1");
  assert.deepEqual(schema.properties.mode.enum, CONTRACT_MODES);
  assert.deepEqual(schema.properties.edge.properties.kind.enum, CONTRACT_EDGE_KINDS);
  assert.match(declarations, /export interface ContractIr/);
  assert.match(declarations, /export type ContractMode/);
  assert.match(declarations, /export type ContractEdgeKind/);
});

test("OpenAPI and Pact import into the IR and export without losing required-shape info", () => {
  const openApi = {
    openapi: "3.1.0",
    info: { title: "Orders", version: "1.0.0" },
    paths: {
      "/orders/{id}": {
        get: {
          operationId: "getOrder",
          parameters: [
            { name: "id", in: "path", required: true, schema: { type: "string" } }
          ],
          responses: {
            "200": {
              description: "ok",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["id", "tenantId"],
                    properties: {
                      id: { type: "string" },
                      tenantId: { type: "string" }
                    }
                  }
                }
              }
            }
          }
        }
      }
    }
  };

  const pact = {
    consumer: { name: "worker@1.4.2" },
    provider: { name: "orders-api@1.8.0" },
    interactions: [
      {
        description: "order created",
        request: { method: "POST", path: "/events/order.created" },
        response: {
          status: 202,
          body: { id: "ord_1", tenantId: "tenant_1" },
          matchingRules: {
            "$.body": {
              matchers: [{ match: "type" }]
            }
          }
        }
      }
    ]
  };

  const openApiContract = importOpenApiContract(openApi, {
    id: "contract-openapi-orders",
    producer: "orders-api@1.8.0",
    consumer: "web@2.0.0"
  });
  const pactContract = importPactContract(pact, {
    id: "contract-pact-order-created",
    eventType: "order.created"
  });

  assert.equal(parseContract(openApiContract).ok, true);
  assert.equal(parseContract(pactContract).ok, true);
  assert.deepEqual(openApiContract.requiredRecord.requiredFields, ["id", "tenantId"]);
  assert.deepEqual(pactContract.requiredRecord.requiredFields, ["id", "tenantId"]);

  assert.deepEqual(exportOpenApiContract(openApiContract).requiredFields, ["id", "tenantId"]);
  assert.deepEqual(exportPactContract(pactContract).requiredFields, ["id", "tenantId"]);
});

test("contract modes preserve honest provenance and sample coverage boundaries", () => {
  const declared = createContractFixture({ mode: "declared" });
  const inferred = createContractFixture({ mode: "inferred" });
  const observed = createContractFixture({ mode: "observed" });
  const promoted = createContractFixture({ mode: "promoted" });

  assert.equal(parseContract(declared).ok, true);
  assert.equal(parseContract(inferred).ok, true);
  assert.equal(parseContract(observed).ok, true);
  assert.equal(parseContract(promoted).ok, true);
  assert.equal("sampleCoverage" in declared.provenance, false);
  assert.equal("sampleCoverage" in inferred.provenance, false);
  assert.equal(observed.provenance.verifiedByConstruction, false);
  assert.equal(promoted.provenance.verifiedByConstruction, false);
  assert.equal(promoted.provenance.migrationWindow.days, 14);
});

test("observed and promoted contracts cannot be over-claimed as proven by construction", () => {
  const observed = createContractFixture({ mode: "observed" });
  observed.provenance.verifiedByConstruction = true;
  delete observed.provenance.sampleCoverage;

  const promoted = createContractFixture({ mode: "promoted" });
  promoted.provenance.sampleCoverage.samples = 0;
  delete promoted.provenance.migrationWindow;

  const observedResult = parseContract(observed);
  const promotedResult = parseContract(promoted);

  assert.equal(observedResult.ok, false);
  assert.match(observedResult.errors.join("\n"), /observed contracts must carry sampleCoverage/);
  assert.match(observedResult.errors.join("\n"), /observed contracts are confidence-bounded/);

  assert.equal(promotedResult.ok, false);
  assert.match(promotedResult.errors.join("\n"), /promoted contracts must carry migrationWindow/);
  assert.match(promotedResult.errors.join("\n"), /sampleCoverage\.samples must be > 0/);
});

test("external imports cannot inject source-of-truth mode or unauditable fields", () => {
  assert.throws(
    () =>
      importOpenApiContract(
        {
          openapi: "3.1.0",
          "x-hobo-mode": "promoted",
          paths: {}
        },
        { id: "bad", producer: "api", consumer: "client" }
      ),
    /external adapters cannot set Contract IR mode/
  );

  const contract = createContractFixture();
  contract.externalSourceOfTruth = { hidden: "pact" };
  contract.edge.kind = "made-up-edge";
  contract.requiredRecord = { type: "object" };

  const parsed = parseContract(contract);

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /externalSourceOfTruth is not allowed/);
  assert.match(parsed.errors.join("\n"), /unknown edge.kind made-up-edge/);
  assert.match(parsed.errors.join("\n"), /requiredRecord.requiredFields must be an array/);
});

test("conflicting consumer requirements remain representable for can-deploy to resolve later", () => {
  const contract = createContractFixture({
    edgeKind: "event",
    consumerRequirements: [
      {
        consumer: "worker@1.4.2",
        requiredFields: ["id", "tenantId"]
      },
      {
        consumer: "audit@3.0.0",
        requiredFields: ["id", "actor", "tenantId"]
      }
    ]
  });

  const parsed = parseContract(contract);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.deepEqual(parsed.contract.consumerRequirements, [
    {
      consumer: "audit@3.0.0",
      requiredFields: ["actor", "id", "tenantId"]
    },
    {
      consumer: "worker@1.4.2",
      requiredFields: ["id", "tenantId"]
    }
  ]);
});

test("AsyncAPI and Protobuf import into the IR and export without losing required-shape info", () => {
  const asyncApi = {
    asyncapi: "2.6.0",
    info: { title: "orders-stream@1.0.0", version: "1.0.0" },
    channels: {
      "order.created": {
        subscribe: {
          message: {
            name: "OrderCreated",
            payload: {
              type: "object",
              required: ["id", "tenantId"],
              properties: {
                id: { type: "string" },
                tenantId: { type: "string" }
              }
            }
          }
        }
      }
    }
  };

  const proto = {
    syntax: "proto3",
    package: "orders.v1",
    messages: [
      {
        name: "Order",
        fields: [
          { name: "id", type: "string", required: true },
          { name: "tenantId", type: "string", required: true },
          { name: "note", type: "string" }
        ]
      }
    ]
  };

  const asyncApiContract = importAsyncApiContract(asyncApi, {
    id: "contract-asyncapi-order-created",
    eventType: "order.created"
  });
  const protobufContract = importProtobufContract(proto, {
    id: "contract-protobuf-order",
    producer: "orders-api@1.8.0",
    consumer: "worker@1.4.2"
  });

  assert.equal(parseContract(asyncApiContract).ok, true);
  assert.equal(parseContract(protobufContract).ok, true);
  assert.equal(asyncApiContract.edge.kind, "event");
  assert.equal(protobufContract.edge.kind, "message");
  assert.deepEqual(asyncApiContract.requiredRecord.requiredFields, ["id", "tenantId"]);
  assert.deepEqual(protobufContract.requiredRecord.requiredFields, ["id", "tenantId"]);

  assert.deepEqual(exportAsyncApiContract(asyncApiContract).requiredFields, ["id", "tenantId"]);
  assert.deepEqual(exportProtobufContract(protobufContract).requiredFields, ["id", "tenantId"]);
});

test("AsyncAPI and Protobuf adapters cannot inject source-of-truth mode or provenance", () => {
  assert.throws(
    () =>
      importAsyncApiContract(
        { asyncapi: "2.6.0", "x-hobo-mode": "promoted", channels: {} },
        { id: "bad", eventType: "evt" }
      ),
    /external adapters cannot set Contract IR mode/
  );
  assert.throws(
    () =>
      importProtobufContract(
        { syntax: "proto3", "x-hobo-provenance": "promotion-gate", messages: [] },
        { id: "bad" }
      ),
    /external adapters cannot set Contract IR mode/
  );
});
