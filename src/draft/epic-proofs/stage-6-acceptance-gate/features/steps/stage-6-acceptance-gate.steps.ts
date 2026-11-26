/**
 * Executable step definitions for stage-6-acceptance-gate.feature.
 *
 * Drives the epic's real drill module (src/stage-6-acceptance-drill.ts)
 * over the committed fixture scenarios — the green GA drill plus the
 * adversarial fixtures that must fail the gate. Pact boundaries are the
 * mocked subsystem seams the drill re-verifies.
 */
import assert from "node:assert/strict";
import { Given, Then, When } from "@cucumber/cucumber";

import {
  createStage6DrillHarness,
  loadDrillFixture,
  REQUIRED_PRIOR_STAGES,
  runStage6AcceptanceDrill,
  verifyPactContracts,
  type Stage6DrillScenario,
} from "../../src/stage-6-acceptance-drill.js";

type Fixture = { scenarios: Record<string, Stage6DrillScenario> };

let fixturePromise: Promise<Fixture> | undefined;
function fixture(): Promise<Fixture> {
  // SAFETY: assertion to `adDrillFixture() as Promise<Fixture>; ` is required at this boundary.
  fixturePromise ??= loadDrillFixture() as Promise<Fixture>;
  return fixturePromise;
}

type Stage6World = {
  scenario?: Stage6DrillScenario;
  drill?: ReturnType<typeof runStage6AcceptanceDrill>;
};

const world: Stage6World = {};

// --- Scenario: Green fixture closes v1 GA readiness --------------------------

Given(
  "the mocked Stage-6 green drill fixture with canary, FinOps, DR, dashboard, governance, and prior-gate evidence",
  async () => {
    world.scenario = (await fixture()).scenarios.greenDrill;
    assert.ok(world.scenario, "the greenDrill fixture scenario must exist");
    assert.equal(world.scenario.name, "stage-6-ga-green");
  },
);

When("the Stage-6 acceptance drill runs in CI", () => {
  assert.ok(world.scenario, "a fixture scenario must be given");
  world.drill = runStage6AcceptanceDrill(world.scenario);
});

Then("all six Stage-6 release-criteria checks pass", () => {
  const drill = world.drill;
  assert.ok(drill, "the drill must have run");
  assert.equal(drill.ok, true);
  assert.equal(drill.checks.length, 6, "the gate is exactly six release-criteria checks");
  assert.ok(
    drill.checks.every((check) => check.status === "pass"),
    `every check passes: ${JSON.stringify(drill.checks.map((c) => [c.id, c.status]))}`,
  );
});

Then("prior gates S0 through S5 re-run green per ADR-0063", () => {
  const drill = world.drill;
  assert.ok(drill);
  assert.deepEqual(
    drill.priorGates.map((gate) => gate.stage),
    [...REQUIRED_PRIOR_STAGES],
  );
  assert.ok(drill.priorGates.every((gate) => gate.status === "pass"));
});

Then(
  "the Stage-6 evidence attaches to acceptance record {string} with the v1 GA checklist complete",
  (recordId: string) => {
    const drill = world.drill;
    assert.ok(drill);
    assert.equal(drill.acceptanceRecordId, recordId);
    assert.equal(drill.evidenceAttached, true);
    assert.equal(drill.v1GaChecklistComplete, true);
    assert.deepEqual(drill.v1GaChecklistIncomplete, []);
  },
);

Then("every Stage-6 mocked boundary pact verifies", async () => {
  assert.ok(world.scenario);
  const harness = createStage6DrillHarness(world.scenario);
  const verification = await verifyPactContracts(harness);
  assert.equal(verification.status, "verified");
  assert.ok(
    verification.boundaries.every((boundary: { verified: boolean }) => boundary.verified),
    "every pact boundary verifies against the drill outputs",
  );
});

// --- Adversarial scenarios ----------------------------------------------------

Given("the adversarial Stage-6 fixture {string}", async (key: string) => {
  const scenarios = (await fixture()).scenarios;
  world.scenario = scenarios[key];
  assert.ok(world.scenario, `fixture scenario ${key} must exist`);
});

When("the Stage-6 acceptance drill evaluates the adversarial fixture", () => {
  assert.ok(world.scenario, "a fixture scenario must be given");
  world.drill = runStage6AcceptanceDrill(world.scenario);
});

Then("the Stage-6 gate fails on check {string}", (checkId: string) => {
  const drill = world.drill;
  assert.ok(drill, "the drill must have run");
  assert.equal(drill.ok, false, "the adversarial fixture must fail the gate");
  const check = drill.checks.find((entry) => entry.id === checkId);
  assert.ok(check, `check ${checkId} must be part of the gate`);
  assert.equal(check.status, "fail", `${checkId} fails: ${check.detail}`);
});

Then("no Stage-6 acceptance evidence is attached", () => {
  assert.equal(world.drill?.evidenceAttached, false);
});
