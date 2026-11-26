/**
 * Executable step definitions for sdk-authoring-ifc-bindles.feature.
 *
 * Drives the epic's real reference service
 * (services/sdk-authoring-reference-architecture.ts) over the committed
 * scenario fixture: manifest lowering, guardrail evaluation, Hobo Code DSL
 * parity, and non-TS parity — all mocked boundaries, no live codegen.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  loadSdkAuthoringScenarioFixture,
  runSdkAuthoringReferenceSimulation,
} from "../../services/sdk-authoring-reference-architecture.js";

type Simulation = Awaited<ReturnType<typeof runSdkAuthoringReferenceSimulation>>;
type Fixture = Awaited<ReturnType<typeof loadSdkAuthoringScenarioFixture>>;

let simulationPromise: Promise<Simulation> | undefined;
function simulation(): Promise<Simulation> {
  simulationPromise ??= runSdkAuthoringReferenceSimulation();
  return simulationPromise;
}

type AuthoringWorld = {
  fixture?: Fixture;
  sim?: Simulation;
};

const world: AuthoringWorld = {};

// --- Scenario: IfC declarations lower to one deterministic manifest ----------

Given("the sample Bindle authored through the IfC scenario fixture", async () => {
  world.fixture = await loadSdkAuthoringScenarioFixture();
  assert.ok(world.fixture.resources.length > 0, "the fixture declares resources");
});

When("the SDK authoring reference simulation lowers the declarations", async () => {
  world.sim = await simulation();
  assert.equal(world.sim.epic.slug, "sdk-authoring-ifc-bindles");
});

Then("one deterministic hobo.manifest v1 is emitted for the authored Bindle", () => {
  const sim = world.sim;
  const fixture = world.fixture;
  assert.ok(sim && fixture);
  assert.equal(sim.manifest.schema, "hobo.manifest/v1");
  assert.equal(sim.manifest.contentHash, "sha256:sdk-authoring-reference-001");
  assert.equal(
    sim.manifest.resources.length,
    fixture.resources.length,
    "every declared resource lowers into the manifest",
  );
  assert.deepEqual(
    Object.keys(sim.manifest.connectors),
    fixture.xaaTargets.map((target: { name: string }) => target.name),
    "every XAA target lowers to a connector entry",
  );
  assert.deepEqual(sim.liveNetworkCalls, [], "lowering makes no live network calls");
});

Then("the generated IfC type surface is clean with no drift", () => {
  const sim = world.sim;
  assert.ok(sim);
  assert.equal(sim.codegen.status, "clean");
  assert.deepEqual(sim.codegen.drift, []);
  assert.equal(sim.codegen.rawEscapeHatchesTypedAs, "unknown");
  assert.equal(sim.codegen.mcpParity, true);
});

// --- Scenario: Authoring guardrails surface before deploy --------------------

Given(
  "the IfC guardrail inputs with unobserved, narrowed, and widened declarations",
  async () => {
    world.fixture = await loadSdkAuthoringScenarioFixture();
    assert.ok(world.fixture.guardrailInputs, "the fixture seeds guardrail violations");
  },
);

When("the SDK authoring guardrails evaluate the declarations", async () => {
  world.sim = await simulation();
});

Then(
  "collection coverage, permission narrowing, and XAA scope widening each fail closed",
  () => {
    const guardrails = world.sim?.guardrails;
    assert.ok(guardrails, "guardrails must have been evaluated");
    assert.equal(guardrails.collectionCoverage.ok, false);
    assert.equal(guardrails.collectionCoverage.reason, "collection.coverage.unobserved-resource");
    assert.equal(guardrails.permissionNarrowing.ok, false);
    assert.equal(guardrails.permissionNarrowing.reason, "capability.required-not-granted");
    assert.equal(guardrails.xaaScopeWidening.ok, false);
    assert.equal(
      guardrails.xaaScopeWidening.reason,
      "requested-scope-exceeds-inferred-manifest-scope",
    );
  },
);

Then("raw driver usage is marked as portability debt", () => {
  const guardrails = world.sim?.guardrails;
  assert.ok(guardrails);
  assert.equal(guardrails.rawDriverDebt.marker, "RAW_DRIVER_PORTABILITY_DEBT");
  assert.equal(guardrails.rawDriverDebt.severity, "warn");
});

// --- Scenario: Hobo Code DSL stays a lowering front door with parity ---------

Given("the same Bindle authored in the Hobo Code DSL", async () => {
  world.fixture = await loadSdkAuthoringScenarioFixture();
  assert.ok(world.fixture.hoboCode.sourceName, "the fixture carries a DSL source");
});

When("the DSL lowers next to the TypeScript authoring path", async () => {
  world.sim = await simulation();
});

Then("the DSL manifest is byte-identical to the TypeScript manifest", () => {
  const sim = world.sim;
  assert.ok(sim);
  assert.equal(sim.hoboCode.byteIdenticalToTypescriptManifest, true);
  assert.equal(sim.hoboCode.manifestHash, sim.manifest.contentHash);
  assert.equal(
    sim.hoboCode.hostImportsRejected.reason,
    "host-imports-not-allowed-in-l1",
    "host imports stay rejected at the L1 lowering boundary",
  );
});

Then(
  "non-TypeScript parity requires a semantics annex instead of copied syntax",
  () => {
    const parity = world.sim?.nonTsParity;
    assert.ok(parity, "the non-TS parity lane must have run");
    assert.equal(parity.status, "requires-semantics-annex");
    assert.equal(parity.semanticsAnnex, "required");
    assert.equal(parity.typeScriptSyntaxCopied, false);
  },
);
