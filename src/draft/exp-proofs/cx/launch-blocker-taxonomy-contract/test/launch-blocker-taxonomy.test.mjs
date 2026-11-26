import assert from "node:assert/strict";
import { test } from "vitest";

import {
  FINDING_SOURCES,
  LAUNCH_DECISION_CLASSES,
  REQUIRED_GATES,
  assertLaunchBlockerTaxonomy,
  classifyLaunchFinding,
  launchBlockerTaxonomy,
  validateExceptionRequest,
  validateLaunchBlockerTaxonomy
} from "../src/launch-blocker-taxonomy.mjs";

test("taxonomy defines launch blocker, high-risk non-blocker, launch note, and post-GA follow-up", () => {
  const result = validateLaunchBlockerTaxonomy(launchBlockerTaxonomy);

  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.deepEqual(
    launchBlockerTaxonomy.severityTaxonomy.map((entry) => entry.id),
    LAUNCH_DECISION_CLASSES
  );
  assert.ok(launchBlockerTaxonomy.severityTaxonomy.every((entry) => entry.goNoGoAction));
  assert.equal(launchBlockerTaxonomy.severityTaxonomy.find((entry) => entry.id === "launch-blocker").mayShip, false);
});

test("exception process requires evidence and approver role without overriding gates", () => {
  const request = {
    decisionClass: "high-risk-non-blocker",
    evidence: {
      findingRecord: "DOGFOOD-17",
      impact: "Hosted dogfood has degraded deploy latency, no correctness loss",
      mitigation: "Keep rollout behind beta flag and page support owner on p95 breach",
      expiry: "2026-07-15"
    },
    approverRole: "release-owner"
  };

  assert.deepEqual(validateExceptionRequest(request), { ok: true, errors: [] });

  assert.equal(validateExceptionRequest({ ...request, decisionClass: "launch-blocker" }).ok, false);
  assert.equal(validateExceptionRequest({ ...request, approverRole: "developer" }).ok, false);
  assert.equal(
    validateExceptionRequest({
      ...request,
      gateOverrides: ["ci"]
    }).ok,
    false
  );
});

test("dogfood, beta, support, security, legal/privacy, and upgrade findings feed go/no-go", () => {
  assert.deepEqual(
    launchBlockerTaxonomy.sourceRouting.map((route) => route.source),
    FINDING_SOURCES
  );

  const blocked = classifyLaunchFinding({
    source: "security",
    requiredGate: "security",
    gateStatus: "failing",
    customerImpact: "credential exposure",
    mitigationReady: false
  });
  assert.equal(blocked.decisionClass, "launch-blocker");
  assert.equal(blocked.goNoGoAction, "no-go");

  const note = classifyLaunchFinding({
    source: "support",
    customerVisibleLimitation: true,
    mitigationReady: true,
    ownerAcceptedRisk: true
  });
  assert.equal(note.decisionClass, "launch-note");
});

test("example triage cases cover each decision class and every required source", () => {
  const classes = new Set(launchBlockerTaxonomy.exampleTriageCases.map((example) => example.decisionClass));
  const sources = new Set(launchBlockerTaxonomy.exampleTriageCases.map((example) => example.source));

  assert.deepEqual([...classes].sort(), [...LAUNCH_DECISION_CLASSES].sort());
  assert.deepEqual([...sources].sort(), [...FINDING_SOURCES].sort());
});

test("scope guard rejects blocker resolution and required-gate bypass", () => {
  const invalid = structuredClone(launchBlockerTaxonomy);
  invalid.scopeGuards.resolvesBlockers = true;
  invalid.scopeGuards.overridesRequiredGates.push("review");
  invalid.requiredGates = invalid.requiredGates.filter((gate) => gate !== "contract-tests");

  const result = validateLaunchBlockerTaxonomy(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /does not resolve blockers/);
  assert.match(result.errors.join("\n"), /must not override required gates/);
  assert.match(result.errors.join("\n"), /required gates must include/);
  assert.throws(() => assertLaunchBlockerTaxonomy(invalid), /launch blocker taxonomy invalid/);
  assert.deepEqual(REQUIRED_GATES, ["ci", "review", "security", "contract-tests"]);
});
