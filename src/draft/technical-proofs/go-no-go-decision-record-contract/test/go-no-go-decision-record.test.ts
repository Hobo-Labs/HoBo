import assert from "node:assert/strict";
import { test } from "vitest";

import {
  REQUIRED_GATES,
  assertGoNoGoDecisionWorkflow,
  goNoGoDecisionWorkflow,
  validateGoNoGoDecisionWorkflow
} from "../src/go-no-go-decision-record.js";

test("decision record template contains the required release signoff fields", () => {
  const workflow = assertGoNoGoDecisionWorkflow(goNoGoDecisionWorkflow);

  assert.deepEqual(
    workflow.template.requiredFields,
    [
      "gate",
      "decision",
      "approverRole",
      "evidenceLinks",
      "blockerDeltas",
      "acceptedRisks",
      "expiryOrRevisitDate"
    ]
  );
});

test("workflow covers beta, release-candidate, and GA decisions", () => {
  const workflow = assertGoNoGoDecisionWorkflow(goNoGoDecisionWorkflow);

  assert.deepEqual(workflow.gates, REQUIRED_GATES);
  assert.equal(workflow.gateWorkflow.length, 3);
  assert.ok(workflow.gateWorkflow.every((step) => step.requiredEvidence.length > 0));
  assert.ok(workflow.gateWorkflow.every((step) => step.allowedDecisions.includes("no-go")));
});

test("exceptions require owner, mitigation, launch note or follow-up, and revisit date", () => {
  const workflow = assertGoNoGoDecisionWorkflow(goNoGoDecisionWorkflow);

  assert.ok(workflow.exceptionPolicy.requiredFields.includes("owner"));
  assert.ok(workflow.exceptionPolicy.requiredFields.includes("mitigation"));
  assert.ok(workflow.exceptionPolicy.requiredFields.includes("launchNoteOrFollowUp"));
  assert.ok(workflow.exceptionPolicy.requiredFields.includes("expiryOrRevisitDate"));

  const invalid = structuredClone(goNoGoDecisionWorkflow);
  invalid.exceptionPolicy.requiredFields = ["owner", "mitigation"];

  const result = validateGoNoGoDecisionWorkflow(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /exception policy is missing launchNoteOrFollowUp/);
  assert.match(result.errors.join("\n"), /exception policy is missing expiryOrRevisitDate/);
});

test("scope guards reject current risk approval and launch-blocker waivers", () => {
  const workflow = assertGoNoGoDecisionWorkflow(goNoGoDecisionWorkflow);

  assert.equal(workflow.scopeGuard.approvesCurrentRisk, false);
  assert.ok(workflow.scopeGuard.forbiddenActions.includes("approve-current-risk"));
  assert.ok(workflow.exceptionPolicy.forbiddenClasses.includes("launch-blocker"));
  assert.ok(workflow.exceptionPolicy.cannotOverrideRequiredGates);

  const invalid = structuredClone(goNoGoDecisionWorkflow);
  invalid.scopeGuard.approvesCurrentRisk = true;
  invalid.exceptionPolicy.forbiddenClasses = [];
  invalid.exceptionPolicy.cannotOverrideRequiredGates = false;

  const result = validateGoNoGoDecisionWorkflow(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not approve current risks/);
  assert.match(result.errors.join("\n"), /launch blockers cannot be waived by exception/);
  assert.match(result.errors.join("\n"), /exceptions cannot override required gates/);
});
