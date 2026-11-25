import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  NoRouteError,
  PAYMENTS_PORT,
  ReplayDivergenceError,
  StubSchemaError,
  createPaymentsPortSchema,
  createReplayHarness,
  createStubMembrane,
  exportRecordedTrace,
  parseChargeInput,
  parseChargeOutput,
  replayRecordedTrace,
  stub,
} from "../src/wit-port-stub.js";

const chargeInput = { amountCents: 2500, currency: "USD" };

test("parseChargeInput rejects invalid payloads at the boundary", () => {
  assert.throws(() => parseChargeInput({ amountCents: -1, currency: "USD" }), StubSchemaError);
  const parsed = parseChargeInput(chargeInput);
  assert.equal(parsed.amountCents, 2500);
});

test("parseChargeOutput returns frozen derived type", () => {
  const parsed = parseChargeOutput({ status: "ok", transactionId: "txn-1" });
  assert.equal(parsed.status, "ok");
  assert.throws(() => {
    parsed.status = "declined";
  });
});

test("reference checkout app runs end-to-end with payments port stubbed", async () => {
  const membrane = createStubMembrane();
  const portSchema = createPaymentsPortSchema();

  membrane.registerComponent({ id: "checkout", imports: [PAYMENTS_PORT] });
  const link = stub({
    membrane,
    componentId: "checkout",
    portInterface: PAYMENTS_PORT,
    portSchema,
  });

  const result = await membrane.callImport("checkout", PAYMENTS_PORT, "charge", chargeInput);

  assert.equal(link.boundaryMode, "mock");
  assert.deepEqual(result, { status: "ok", transactionId: "stub-txn-1" });
});

test("stubbed calls emit stub.Recorded and link.Called events", async () => {
  const membrane = createStubMembrane();
  const portSchema = createPaymentsPortSchema();

  membrane.registerComponent({ id: "checkout", imports: [PAYMENTS_PORT] });
  stub({ membrane, componentId: "checkout", portInterface: PAYMENTS_PORT, portSchema });

  await membrane.callImport("checkout", PAYMENTS_PORT, "charge", chargeInput);

  const recorded = membrane.events.filter((event) => event.type === "stub.Recorded");
  const called = membrane.events.filter((event) => event.type === "link.Called");

  assert.equal(recorded.length, 1);
  assert.equal(called.length, 1);
  assert.equal(recorded[0].operation, "charge");
  assert.deepEqual(recorded[0].input, chargeInput);
  assert.deepEqual(recorded[0].output, { status: "ok", transactionId: "stub-txn-1" });
  assert.equal(called[0].boundaryMode, "mock");
});

test("recorded trace exports for Camp event store and replays deterministically", async () => {
  const membrane = createStubMembrane();
  const portSchema = createPaymentsPortSchema();

  membrane.registerComponent({ id: "checkout", imports: [PAYMENTS_PORT] });
  stub({ membrane, componentId: "checkout", portInterface: PAYMENTS_PORT, portSchema });
  await membrane.callImport("checkout", PAYMENTS_PORT, "charge", chargeInput);

  const trace = exportRecordedTrace(membrane);
  assert.equal(trace.schema, "hobo.stub.recorded-trace/v1");
  assert.equal(trace.entries.length, 1);

  const replayAdapter = {
    async charge(input) {
      return { status: "ok", transactionId: "stub-txn-1", echoed: input.amountCents };
    },
  };

  await assert.rejects(
    () => replayRecordedTrace({ membrane, trace, adapter: replayAdapter }),
  (error) => error instanceof ReplayDivergenceError,
  );

  const faithfulAdapter = {
    async charge() {
      return { status: "ok", transactionId: "stub-txn-1" };
    },
  };

  const replayResult = await replayRecordedTrace({
    membrane,
    trace,
    adapter: faithfulAdapter,
  });

  assert.equal(replayResult.ok, true);
  assert.equal(replayResult.deterministic, true);
  assert.equal(
    membrane.events.some((event) => event.type === "stub.ReplayCompleted"),
    true,
  );
});

test("partial stub overrides return canned behavior per operation", async () => {
  const membrane = createStubMembrane();
  const portSchema = createPaymentsPortSchema();

  membrane.registerComponent({ id: "checkout", imports: [PAYMENTS_PORT] });
  stub({
    membrane,
    componentId: "checkout",
    portInterface: PAYMENTS_PORT,
    portSchema,
    overrides: {
      charge: () => ({ status: "declined", transactionId: "stub-decline-1" }),
    },
  });

  const result = await membrane.callImport("checkout", PAYMENTS_PORT, "charge", chargeInput);
  assert.deepEqual(result, { status: "declined", transactionId: "stub-decline-1" });
});

test("schema-invalid stub responses fail closed at the boundary", async () => {
  const membrane = createStubMembrane();
  const portSchema = createPaymentsPortSchema();

  membrane.registerComponent({ id: "checkout", imports: [PAYMENTS_PORT] });
  stub({
    membrane,
    componentId: "checkout",
    portInterface: PAYMENTS_PORT,
    portSchema,
    overrides: {
      charge: () => ({ status: "bogus", transactionId: "" }),
    },
  });

  await assert.rejects(
    () => membrane.callImport("checkout", PAYMENTS_PORT, "charge", chargeInput),
    (error) => error instanceof StubSchemaError && error.code === "stub.schema-invalid",
  );
});

test("unlinked imports fail with typed no-route instead of panicking", async () => {
  const membrane = createStubMembrane();
  membrane.registerComponent({ id: "checkout", imports: [PAYMENTS_PORT] });

  await assert.rejects(
    () => membrane.callImport("checkout", PAYMENTS_PORT, "charge", chargeInput),
    (error) => error instanceof NoRouteError && error.code === "no-route",
  );
});

test("replay harness rejects nondeterministic adapter output", async () => {
  const trace = {
    entries: [
      {
        function: "charge",
        input: chargeInput,
        output: { status: "ok", transactionId: "stub-txn-1" },
      },
    ],
  };

  const harness = createReplayHarness({
    adapter: {
      async charge() {
        return { status: "ok", transactionId: "different-txn" };
      },
    },
  });

  await assert.rejects(
    () => harness.replay(trace),
    (error) => error instanceof ReplayDivergenceError,
  );
});

test("report records HOBO-651 scope and S1-12 replay harness stand-in", () => {
  const membrane = createStubMembrane();
  const report = membrane.report();

  assert.equal(report.issue, "HOBO-651");
  assert.deepEqual(report.boundaryModes, ["live", "mock"]);
  assert.ok(report.events.includes("stub.Recorded"));
  assert.ok(report.scopeIn.some((item) => item.includes("S1-12")));
});

test("architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries", () => {
  const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const proto = readFileSync(
    new URL("../architecture/wit_port_stub_contract.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../architecture/wit_port_stub_contract.cue", import.meta.url),
    "utf8",
  );
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/wit_port_stub_contract.pact.json", import.meta.url),
      "utf8",
    ),
  );

  for (const typeName of ["WitPortStubContractRecord", "StubRecordedTraceEntry", "StubRecordedTrace"]) {
    assert.match(proto, new RegExp(`message ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.equal(pact.consumer.name, "WitPortStubContractConsumer");
  assert.equal(pact.provider.name, "WitPortStubContractBoundary");
  assert.equal(pact.interactions[0].response.body.ok, true);
  assert.match(adr, /parse, don't validate/i);
  assert.match(adr, /Command/i);
  assert.match(adr, /Event/i);
  assert.match(adr, /Actor/i);
  assert.match(adr, /event store/i);
  assert.match(adr, /projection/i);
  assert.match(adr, /read store/i);
});
