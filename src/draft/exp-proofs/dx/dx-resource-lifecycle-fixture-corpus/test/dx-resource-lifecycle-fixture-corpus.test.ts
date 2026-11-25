import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS,
  REQUIRED_ARTIFACTS,
  REQUIRED_BOUNDARY_CONTRACTS,
  REQUIRED_CONSUMERS,
  REQUIRED_FACT_KINDS,
  REQUIRED_SCENARIOS,
  parseDxResourceLifecycleFixtureCorpus,
  validateDxResourceLifecycleFixtureCorpus,
} from "../src/dx-resource-lifecycle-fixture-corpus.js";

test("HOBO-572 corpus covers the required lifecycle scenarios and artifacts", () => {
  const parsed = parseDxResourceLifecycleFixtureCorpus(DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS);

  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.issue, "HOBO-572");
  assert.deepEqual(
    parsed.value.scenarios.map((scenario) => scenario.id),
    REQUIRED_SCENARIOS,
  );

  for (const scenario of parsed.value.scenarios) {
    for (const artifact of REQUIRED_ARTIFACTS) {
      assert.ok(scenario.artifacts.includes(artifact), `${scenario.id} missing ${artifact}`);
    }
  }
});

test("each scenario carries concrete shared fixture facts for downstream proofs", () => {
  const parsed = parseDxResourceLifecycleFixtureCorpus(DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS);

  assert.equal(parsed.ok, true);

  for (const scenario of parsed.value.scenarios) {
    assert.deepEqual(
      scenario.fixtureFacts.map((fact) => fact.kind),
      REQUIRED_FACT_KINDS,
    );
    assert.equal(new Set(scenario.fixtureFacts.map((fact) => fact.id)).size, REQUIRED_FACT_KINDS.length);
    assert.equal(scenario.fixtureFacts.every((fact) => fact.source === "fixture-corpus"), true);
    assert.equal(scenario.fixtureFacts.every((fact) => fact.redacted === true), true);
    assert.equal(scenario.fixtureFacts.every((fact) => fact.tenantSafe === true), true);
    assert.equal(scenario.fixtureFacts.every((fact) => fact.proofMode === scenario.proofMode), true);
  }
});

test("fixtures stay deterministic, redacted, tenant-safe, and reference-labeled by default", () => {
  const result = validateDxResourceLifecycleFixtureCorpus(DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS);

  assert.deepEqual(result.errors, []);
  assert.equal(
    DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.scenarios.every(
      (scenario) =>
        scenario.deterministic === true &&
        scenario.redacted === true &&
        scenario.tenantSafe === true &&
        scenario.proofMode === "reference fixture",
    ),
    true,
  );
});

test("corpus names protobuf, CUE, and Pact boundaries expected by later proofs", () => {
  assert.deepEqual(DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.boundaryContracts, REQUIRED_BOUNDARY_CONTRACTS);
});

test("corpus can be consumed by SDK, CLI, API, docs, and visual proof packages", () => {
  assert.deepEqual(DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.consumers, REQUIRED_CONSUMERS);
});

test("target package and proof-note paths match the Linear issue contract", () => {
  assert.equal(
    DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.packagePath,
    "src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus",
  );
  assert.equal(
    DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.proofNote,
    "docs/design/proofs/dx-resource-lifecycle-fixture-corpus/README.md",
  );
});

test("validation fails closed on missing scenarios, unsafe data, or unsupported proof modes", () => {
  const result = validateDxResourceLifecycleFixtureCorpus({
    ...DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS,
    scenarios: [
      ...DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.scenarios.slice(1),
      {
        ...DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.scenarios[0],
        id: "live-provider",
        proofMode: "live",
        deterministic: false,
        redacted: false,
        tenantSafe: false,
        fixtureFacts: [],
        scopeOutGuard: "Use real customer data, live providers, and production catalog output.",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /missing required scenario: deploy/i);
  assert.match(result.errors.join("\n"), /deterministic/i);
  assert.match(result.errors.join("\n"), /redacted/i);
  assert.match(result.errors.join("\n"), /tenant-safe/i);
  assert.match(result.errors.join("\n"), /live proof/i);
  assert.match(result.errors.join("\n"), /missing fixture fact: resources/i);
  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("parser rejects raw values instead of handing broad DTOs to consumers", () => {
  const parsed = parseDxResourceLifecycleFixtureCorpus({
    ...DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS,
    boundaryContracts: DX_RESOURCE_LIFECYCLE_FIXTURE_CORPUS.boundaryContracts.filter(
      (contract) => contract !== "Pact",
    ),
  });

  assert.equal(parsed.ok, false);
  assert.match(parsed.errors.join("\n"), /missing boundary contract: Pact/i);
  assert.equal("value" in parsed, false);
});

test("parser fails closed on malformed nested raw fixture records", () => {
  const parsed = parseDxResourceLifecycleFixtureCorpus({
    issue: "HOBO-572",
    packagePath: "src/draft/exp-proofs/dx/dx-resource-lifecycle-fixture-corpus",
    proofNote: "docs/design/proofs/dx-resource-lifecycle-fixture-corpus/README.md",
    sourceRefs: "docs/design/developer-experience.md#plan-07",
    boundaryContracts: ["protobuf"],
    consumers: ["sdk-compile-consumer"],
    scenarios: [
      {
        id: "deploy",
        artifacts: "resources",
        fixtureIds: [],
        fixtureFacts: [],
        deterministic: true,
        redacted: true,
        tenantSafe: true,
        proofMode: "reference fixture",
      },
    ],
  });

  assert.equal(parsed.ok, false);
  assert.equal("value" in parsed, false);
  assert.match(parsed.errors.join("\n"), /source refs must be an array/i);
  assert.match(parsed.errors.join("\n"), /scenario deploy missing artifact: resources/i);
  assert.match(parsed.errors.join("\n"), /scenario deploy missing fixture fact: resources/i);
  assert.match(parsed.errors.join("\n"), /scenario deploy must name its scope-out guard/i);
});
