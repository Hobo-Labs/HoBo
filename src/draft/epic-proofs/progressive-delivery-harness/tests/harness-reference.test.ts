import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "vitest";

import {
  CONTRACT_BOUNDARIES,
  createProgressiveDeliveryHarness,
  loadScenarioFixture,
  runHarnessScenario,
  verifyPactContracts,
} from "../src/harness-reference.js";

const fixture = await loadScenarioFixture();

test("healthy canary ramps flag, delivery, and experiment legs through one audit stream", async () => {
  const outcome = await runHarnessScenario(fixture.scenarios.healthyCanary);

  assert.equal(outcome.status, "promoted");
  assert.deepEqual(outcome.rollout.trafficSplits, [10, 50, 100]);
  assert.equal(outcome.flag.evaluation.value, "treatment");
  assert.equal(outcome.flag.evaluation.freshness.status, "fresh");
  assert.equal(outcome.experiment.verdict, "ship");
  assert.ok(outcome.auditEvents.includes("rollout.Promoted"));
  assert.ok(outcome.auditEvents.includes("experiment.Concluded"));
});

test("SLO burn creates auto-revert obligation and rolls traffic back without live services", async () => {
  const outcome = await runHarnessScenario(fixture.scenarios.sloBurnRollback);

  assert.equal(outcome.status, "rolled_back");
  assert.deepEqual(outcome.rollout.trafficSplits, [10, 0]);
  assert.equal(outcome.rollback.obligation.status, "satisfied");
  assert.equal(outcome.rollback.reason, "slo-burn");
  assert.ok(outcome.auditEvents.includes("policy.ObligationCreated"));
  assert.ok(outcome.auditEvents.includes("rollout.RolledBack"));
});

test("stale rulesets and underpowered experiment looks fail closed", async () => {
  const stale = await runHarnessScenario(fixture.scenarios.staleRuleset);
  const underpowered = await runHarnessScenario(fixture.scenarios.underpoweredExperiment);

  assert.equal(stale.status, "held");
  assert.equal(stale.flag.evaluation.freshness.status, "stale");
  assert.equal(stale.holdReason, "stale-ruleset");
  assert.equal(underpowered.status, "promoted");
  assert.equal(underpowered.experiment.verdict, "do-not-conclude");
  assert.equal(underpowered.experiment.reason, "underpowered");
});

test("stuck rollout and failed rollback compensation escalate instead of self-certifying", async () => {
  const stuck = await runHarnessScenario(fixture.scenarios.stuckRollout);
  const rollbackFailure = await runHarnessScenario(fixture.scenarios.rollbackCompensationFailure);

  assert.equal(stuck.status, "needs-human");
  assert.equal(stuck.rollout.convergence, "traffic-split-not-converged");
  assert.equal(rollbackFailure.status, "needs-human");
  assert.equal(rollbackFailure.rollback.obligation.status, "escalated");
  assert.ok(rollbackFailure.auditEvents.includes("rollout.NeedsHuman"));
});

test("every service boundary has a Pact file and verifies against mocked providers", async () => {
  const harness = createProgressiveDeliveryHarness(fixture.scenarios.healthyCanary);
  const result = await verifyPactContracts(harness);

  assert.equal(result.status, "verified");
  assert.deepEqual(
    result.boundaries.map((boundary) => boundary.id).sort(),
    CONTRACT_BOUNDARIES.map((boundary) => boundary.id).sort(),
  );

  for (const boundary of CONTRACT_BOUNDARIES) {
    const pact = JSON.parse(await readFile(new URL(`../contracts/pacts/${boundary.pactFile}`, import.meta.url), "utf8"));
    assert.equal(pact.metadata.boundaryId, boundary.id);
    assert.equal(pact.consumer.name, "progressive-delivery-harness-reference");
    assert.ok(pact.provider.name);
    assert.ok(pact.interactions.length > 0);
  }
});
