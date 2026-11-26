import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_PROOF_SURFACES,
  canCreateOutcomeActivationFollowUp,
  outcomeActivationRail,
  validateOutcomeActivationRail,
} from "../src/outcome-activation-rail.mjs";

test("rail defines stages with entry criteria, exit criteria, personas, evidence, and handoffs", () => {
  const result = validateOutcomeActivationRail(outcomeActivationRail);

  assert.deepEqual(result.errors, []);
  assert.equal(outcomeActivationRail.issue, "HOBO-508");
  assert.equal(outcomeActivationRail.phase, "M0");
  assert.ok(outcomeActivationRail.stages.length >= 5);

  for (const stage of outcomeActivationRail.stages) {
    assert.ok(stage.id);
    assert.ok(stage.label);
    assert.ok(stage.entryCriteria.length > 0, `${stage.id} missing entry criteria`);
    assert.ok(stage.exitCriteria.length > 0, `${stage.id} missing exit criteria`);
    assert.ok(stage.personaLabels.length > 0, `${stage.id} missing persona labels`);
    assert.ok(stage.evidenceObjects.length > 0, `${stage.id} missing evidence`);
    assert.ok(stage.handoffProjects.length > 0, `${stage.id} missing handoff`);
  }
});

test("rail maps every required proof surface without creating a duplicate product shell", () => {
  assert.deepEqual(outcomeActivationRail.proofSurfaces.map((surface) => surface.id), REQUIRED_PROOF_SURFACES);
  assert.equal(
    outcomeActivationRail.proofSurfaces.every((surface) => surface.sourceProject && surface.existingCapability),
    true,
  );
  assert.equal(outcomeActivationRail.scopeBoundary.kind, "ux-orchestration-layer");
  assert.equal(outcomeActivationRail.scopeBoundary.buildsNewWorkflowEngine, false);
  assert.equal(outcomeActivationRail.scopeBoundary.buildsDuplicateProductShell, false);
});

test("rail separates non-expert buyer or user visibility from technical operator visibility", () => {
  assert.deepEqual(
    outcomeActivationRail.audienceViews.map((view) => view.audience),
    ["non-expert buyer/user", "technical operator"],
  );

  const buyerView = outcomeActivationRail.audienceViews.find((view) => view.audience === "non-expert buyer/user");
  const operatorView = outcomeActivationRail.audienceViews.find((view) => view.audience === "technical operator");

  assert.ok(buyerView.visibleSignals.includes("plain-language outcome"));
  assert.ok(buyerView.hiddenSignals.includes("raw topology graph"));
  assert.ok(operatorView.visibleSignals.includes("plan diff"));
  assert.ok(operatorView.visibleSignals.includes("evidence object ids"));
});

test("follow-up implementation issues are gated until M0 acceptance", () => {
  assert.equal(canCreateOutcomeActivationFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateOutcomeActivationFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateOutcomeActivationFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateOutcomeActivationFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("validation rejects fragmented proof maps and hidden implementation scope creep", () => {
  const invalid = structuredClone(outcomeActivationRail);
  invalid.proofSurfaces = invalid.proofSurfaces.filter((surface) => surface.id !== "safe-tests");
  invalid.scopeBoundary.buildsDuplicateProductShell = true;
  invalid.stages[0].evidenceObjects = [];

  const result = validateOutcomeActivationRail(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing proof surface: safe-tests/);
  assert.match(result.errors.join("\n"), /duplicate product shell is scope-out/);
  assert.match(result.errors.join("\n"), /missing evidence/);
});
