import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { contentDigest } from "../../slsa-provenance-certification-contract/src/provenance.js";
import {
  createPaymentsPortSchema,
  createStubMembrane,
  exportRecordedTrace,
  stub
} from "../../wit-port-stub-contract/src/wit-port-stub.js";
import {
  STUB_IMPLEMENTATION_REPAIR_BUDGET,
  adaptStubRecordedTrace,
  buildStubImplementationGenerationRequest,
  loadPaymentsStubRecordingsFixture,
  parseStubRecordings,
  runNonConvergingStubImplementationGeneration,
  runStubImplementationGeneration
} from "../src/stub-implementation-generation.js";

test("acceptance: stubbed payments port receives generated implementation that passes conformance and reproduces all recorded traces", async () => {
  const parsedStub = loadPaymentsStubRecordingsFixture();
  const result = await runStubImplementationGeneration({
    validationScript: ["trace-mismatch", "pass"]
  });

  assert.equal(result.outcome, "promoted");
  assert.equal(result.parsedStub.stubId, "stub-payments-fixture");
  assert.equal(result.parsedStub.traceIds.length, 2);
  assert.equal(result.conformance.ok, true, result.conformance.reasons.join("\n"));
  assert.equal(result.traceReplay.ok, true, result.traceReplay.reasons.join("\n"));
  assert.deepEqual(result.promotion.reproducedTraces, [...parsedStub.traceIds]);
  assert.equal(result.promotion.event.type, "impl.Promoted");
  assert.deepEqual(
    result.repair.events.map((event) => event.type),
    ["gen.ValidationFailed", "gen.Repaired", "gen.Validated"]
  );
  assert.equal(result.finalValidation.report.traceReplay.passed, true);
});

test("adversarial: trace mismatch blocks promotion even when conformance is green", async () => {
  const result = await runStubImplementationGeneration({
    validationScript: ["trace-mismatch", "trace-mismatch", "trace-mismatch"]
  });

  assert.equal(result.outcome, "needs-human");
  assert.equal(result.promotion, null);
  assert.equal(result.repair.finalEvent.type, "gen.NeedsHuman");
  assert.match(result.repair.finalEvent.data.failingAssertions.join("\n"), /trace:trace:payments-charge-happy-path/);
});

test("adversarial: bounded non-convergence emits one NeedsHuman and never promotes", async () => {
  const result = await runNonConvergingStubImplementationGeneration();

  assert.equal(result.outcome, "needs-human");
  assert.equal(result.repair.repairAttempts, STUB_IMPLEMENTATION_REPAIR_BUDGET);
  assert.equal(result.repair.finalEvent.type, "gen.NeedsHuman");
  assert.equal(result.repair.events.filter((event) => event.type === "gen.NeedsHuman").length, 1);
  assert.equal(result.promotion, null);
});

test("adversarial: contradictory stub material cannot override authoritative WIT target", async () => {
  const contradictoryStub = parseStubRecordings({
    schema: "hobo.stub.recordings/v1",
    port: "hobo:cache/redis@0.1.0",
    stubId: "stub-redis-wrong-port",
    recordings: [
      {
        id: "trace:redis-get",
        type: "link.Called",
        method: "get",
        inputDigest: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
        outputDigest: "sha256:2222222222222222222222222222222222222222222222222222222222222222"
      }
    ]
  });
  const request = buildStubImplementationGenerationRequest({ stubRecordings: contradictoryStub });

  assert.equal(request.target.witPort, "hobo:service/payments@0.1.0");
  assert.equal(request.authoritativeRefs.at(-1).suiteId, "conformance.service.payments@0.1.0");

  await assert.rejects(
    () =>
      runStubImplementationGeneration({
        stubRecordings: contradictoryStub,
        validationScript: ["pass"]
      }),
    /stub\.port_mismatch/
  );
});

test("adversarial: empty stub recordings are rejected at parse boundary", () => {
  assert.throws(
    () =>
      parseStubRecordings({
        schema: "hobo.stub.recordings/v1",
        port: "hobo:service/payments@0.1.0",
        stubId: "empty",
        recordings: []
      }),
    /stub\.recordings_empty/
  );
});

test("determinism: pinned seed reproduces candidate and promotion payload digests", async () => {
  const first = await runStubImplementationGeneration();
  const second = await runStubImplementationGeneration();
  const differentSeed = await runStubImplementationGeneration({ seed: "seed-hobo-652-different" });

  assert.equal(first.finalCandidateRef.digest, second.finalCandidateRef.digest);
  assert.equal(
    contentDigest(first.promotion),
    contentDigest(second.promotion)
  );
  assert.notEqual(first.finalCandidateRef.digest, differentSeed.finalCandidateRef.digest);
});

test("integration: HOBO-651 recorded trace adapts into S5-07 generation input", async () => {
  const membrane = createStubMembrane();
  const portSchema = createPaymentsPortSchema();

  membrane.registerComponent({ id: "checkout", imports: [portSchema.wit] });
  stub({
    membrane,
    componentId: "checkout",
    portInterface: portSchema.wit,
    portSchema
  });
  await membrane.callImport("checkout", portSchema.wit, "charge", {
    amountCents: 2500,
    currency: "USD"
  });

  const trace = exportRecordedTrace(membrane);
  const adapted = adaptStubRecordedTrace(trace, {
    targetPort: "hobo:service/payments@0.1.0",
    stubId: "stub-from-hobo-651"
  });

  assert.equal(adapted.recordings.length, 1);
  assert.equal(adapted.recordings[0].method, "charge");
  assert.equal(adapted.port, "hobo:service/payments@0.1.0");

  const result = await runStubImplementationGeneration({
    stubRecordings: adapted,
    validationScript: ["pass"]
  });
  assert.equal(result.outcome, "promoted");
});

test("architecture artifacts pin protobuf, CUE, Pact, and ADR boundaries", () => {
  const adr = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const proto = readFileSync(
    new URL("../architecture/stub_implementation_generation_contract.proto", import.meta.url),
    "utf8"
  );
  const cue = readFileSync(
    new URL("../architecture/stub_implementation_generation_contract.cue", import.meta.url),
    "utf8"
  );
  const pact = JSON.parse(
    readFileSync(
      new URL("../architecture/pacts/stub_implementation_generation_contract.pact.json", import.meta.url),
      "utf8"
    )
  );

  for (const typeName of ["StubImplementationGenerationRecord"]) {
    assert.match(proto, new RegExp(`message ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.equal(pact.consumer.name, "StubImplementationGenerationContractConsumer");
  assert.equal(pact.provider.name, "StubImplementationGenerationContractBoundary");
  assert.equal(pact.interactions[0].response.body.ok, true);
  assert.match(adr, /parse, don't validate/i);
  assert.match(adr, /Command/i);
  assert.match(adr, /Event/i);
  assert.match(adr, /Actor/i);
  assert.match(adr, /event store/i);
  assert.match(adr, /projection/i);
  assert.match(adr, /read store/i);
});
