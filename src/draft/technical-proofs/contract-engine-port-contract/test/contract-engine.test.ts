import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "vitest";

import {
  BUILT_IN_ENGINE_ID,
  CONTRACT_ENGINE_PORT,
  createContractEngine,
  exportPactBrokerContract,
  importPactBrokerContract,
  registerContractEngineProvider,
} from "../src/contract-engine.js";

const fixtureGraph = Object.freeze({
  deployment: "shop-prod",
  contracts: [
    {
      id: "contract:api->worker:order.created",
      kind: "event",
      producer: "api@1.8.0",
      consumer: "worker@1.4.2",
      channel: "order-events/order.created",
      mode: "inferred",
      requiredFields: ["orderId", "tenantId"],
      optionalFields: ["discountCode"],
    },
  ],
});

const fixtureEventLog = Object.freeze([
  {
    type: "deployment.Running",
    producer: "api@1.8.0",
    consumer: "worker@1.4.2",
  },
  {
    type: "contract.Observed",
    contractId: "contract:api->worker:order.created",
    sampleCount: 42,
    fields: ["orderId", "tenantId", "discountCode"],
  },
]);

describe("contract-engine WIT port contract", () => {
  it("publishes the built-in contract-engine port surface and compiles with the engine", () => {
    const wit = fs.readFileSync(
      new URL("../wit/world.wit", import.meta.url),
      "utf8",
    );

    assert.equal(CONTRACT_ENGINE_PORT, "hobo:contract-engine/contract-engine@0.1.0");
    assert.match(wit, /package hobo:contract-engine@0\.1\.0;/);
    assert.match(wit, /verify: func\(request: verify-request\) -> verify-decision/);

    const engine = createContractEngine();
    assert.equal(engine.id, BUILT_IN_ENGINE_ID);
    assert.equal(engine.behavior, "built-in-pact-style-consumer-driven");
  });

  it("derives a consumer-driven check from the graph and event log without a hand-written Pact file", () => {
    const engine = createContractEngine();
    const decision = engine.verify({
      graph: fixtureGraph,
      eventLog: fixtureEventLog,
      producer: "api@1.8.0",
      consumer: "worker@1.4.2",
      providedContract: {
        channel: "order-events/order.created",
        fields: ["orderId", "tenantId", "discountCode"],
      },
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.engineId, BUILT_IN_ENGINE_ID);
    assert.equal(decision.expectations[0].source, "graph+event-log");
    assert.equal(decision.expectations[0].observedSamples, 42);
    assert.deepEqual(decision.expectations[0].requiredFields, ["orderId", "tenantId"]);
    assert.deepEqual(decision.failures, []);
  });

  it("round-trips an exported Pact broker shape through the HoBo Contract IR", () => {
    const pact = exportPactBrokerContract({
      contractIr: fixtureGraph.contracts,
      producer: "api@1.8.0",
      consumer: "worker@1.4.2",
    });

    assert.equal(pact.metadata.source, "hobo-contract-ir");
    assert.equal(pact.interactions[0].description, "worker@1.4.2 consumes order-events/order.created");

    const imported = importPactBrokerContract(pact);

    assert.equal(imported.authority, "interop-import");
    assert.deepEqual(imported.contracts[0].requiredFields, ["orderId", "tenantId"]);
    assert.equal(imported.contracts[0].sourceOfTruth, false);
  });

  it("has no behavior toggle to disable built-in consumer-driven testing", () => {
    assert.throws(
      () => createContractEngine({ consumerDrivenTesting: false }),
      /consumer-driven testing is mandatory/,
    );

    const engine = createContractEngine();
    assert.equal("disablePactStyleTesting" in engine, false);
    assert.equal("setContractBehavior" in engine, false);
  });

  it("keeps provider-pact as an interop target, never the source of truth", () => {
    const pact = exportPactBrokerContract({
      contractIr: fixtureGraph.contracts,
      producer: "api@1.8.0",
      consumer: "worker@1.4.2",
    });

    assert.throws(
      () => importPactBrokerContract({ ...pact, metadata: { ...pact.metadata, sourceOfTruth: true } }),
      /Pact imports cannot become the Contract IR source of truth/,
    );
  });

  it("checks graph-declared expectations even when traces have not observed them", () => {
    const engine = createContractEngine();
    const decision = engine.verify({
      graph: fixtureGraph,
      eventLog: [],
      producer: "api@1.8.0",
      consumer: "worker@1.4.2",
      providedContract: {
        channel: "order-events/order.created",
        fields: ["orderId", "tenantId"],
      },
    });

    assert.equal(decision.ok, true);
    assert.equal(decision.expectations[0].observedSamples, 0);
    assert.equal(decision.expectations[0].mode, "inferred");
  });

  it("fails verification when the producer omits a consumer-required field", () => {
    const engine = createContractEngine();
    const decision = engine.verify({
      graph: fixtureGraph,
      eventLog: fixtureEventLog,
      producer: "api@1.8.0",
      consumer: "worker@1.4.2",
      providedContract: {
        channel: "order-events/order.created",
        fields: ["orderId"],
      },
    });

    assert.equal(decision.ok, false);
    assert.deepEqual(decision.failures, [
      "contract:api->worker:order.created: missing required field tenantId",
    ]);
  });

  it("rejects second contract-engine providers because the engine is built-in-only", () => {
    assert.throws(
      () => registerContractEngineProvider("provider-pact"),
      /contract-engine is built-in-only/,
    );
  });
});
