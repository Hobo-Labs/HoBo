import assert from "node:assert/strict";
import { test } from "vitest";

import {
  DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE,
  classifyDogfoodPrivateBetaWork,
  cloneMutableDogfoodPrivateBetaEvidence,
  summarizePrivateBetaEvidence,
  validateDogfoodPrivateBetaEvidence,
} from "../src/dogfood-yard-private-beta-evidence.ts";

const REQUIRED_SCENARIOS = [
  "hosted-yard-preview-path",
  "self-hosted-seed-handover",
  "yard-upgrade-and-rollback",
  "incident-debug-and-restore",
];

const REQUIRED_CHANNELS = ["logs", "traces", "status-views", "support-debug", "rollback-signals"];

test("M2 private beta evidence records required owners, sources, blockers, risks, and parent sync", () => {
  const result = validateDogfoodPrivateBetaEvidence(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE);

  assert.deepEqual(result.errors, []);
  assert.equal(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.issue, "HOBO-462");
  assert.equal(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.phase, "M2");
  assert.equal(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.milestoneGate, "M2 Private beta proof");
  assert.ok(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.requiredEvidence.every((item) => item.ownerProject));
  assert.ok(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.blockers.length > 0);
  assert.ok(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.acceptedRisks.length > 0);
  assert.ok(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.crossProjectDependencies.length > 0);
  assert.equal(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.parentInitiativeSync.launchRiskChanged, false);
});

test("private beta scenarios cover hosted, self-hosted, upgrade, and incident evidence without live data", () => {
  assert.deepEqual(
    DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.scenarios.map((scenario) => scenario.id),
    REQUIRED_SCENARIOS,
  );

  for (const scenario of DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.scenarios) {
    assert.ok(scenario.betaCohort, `${scenario.id} must name beta cohort`);
    assert.ok(scenario.exitCriteria.length >= 2, `${scenario.id} must name exit criteria`);
    assert.ok(scenario.evidenceChannels.length >= 2, `${scenario.id} must bind evidence channels`);
    assert.equal(scenario.usesLiveCustomerData, false, `${scenario.id} must use sanitized fixtures only`);
    assert.equal(scenario.callsLiveProviders, false, `${scenario.id} must not call live providers`);
  }
});

test("evidence channels map to owners and redaction rules", () => {
  assert.deepEqual(
    DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.evidenceChannels.map((channel) => channel.id),
    REQUIRED_CHANNELS,
  );

  for (const channel of DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE.evidenceChannels) {
    assert.ok(channel.ownerProject, `${channel.id} must map to owner project`);
    assert.ok(channel.redactionRule, `${channel.id} must name redaction rule`);
    assert.ok(channel.privateBetaUse, `${channel.id} must name private beta use`);
  }
});

test("summary feeds release cutline, support, and beta-readiness views", () => {
  const summary = summarizePrivateBetaEvidence(DOGFOOD_YARD_PRIVATE_BETA_EVIDENCE);

  assert.deepEqual(summary.scenarioIds, REQUIRED_SCENARIOS);
  assert.ok(summary.cutlineEntries.some((entry) => entry.includes("private beta")));
  assert.ok(summary.supportEntries.some((entry) => entry.includes("support-safe")));
  assert.ok(summary.betaReadinessEntries.some((entry) => entry.includes("exit criteria")));
});

test("validation fails closed for pending evidence, speculative follow-ups, and unsynced launch risk", () => {
  const invalid = cloneMutableDogfoodPrivateBetaEvidence();
  invalid.requiredEvidence.find((item) => item.id === "private-beta-scenario-fixtures")!.status = "pending";
  invalid.followUpIssues.push({
    id: "speculative-ga-dashboard",
    ownerProject: "Admin Console",
    missingEvidenceId: "m0-dogfood-yard-scope",
    allowedReason: "Create GA dashboard work even though source evidence is accepted",
  });
  invalid.parentInitiativeSync.launchRiskChanged = true;
  invalid.parentInitiativeSync.statusUpdated = false;

  const result = validateDogfoodPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /private-beta-scenario-fixtures must be accepted/);
  assert.match(result.errors.join("\n"), /follow-up is allowed only for missing evidence/);
  assert.match(result.errors.join("\n"), /parent initiative status must be updated/);
});

test("validation rejects live-provider work, customer data, and production readiness claims", () => {
  const invalid = cloneMutableDogfoodPrivateBetaEvidence();
  invalid.scenarios[0] = {
    ...invalid.scenarios[0],
    usesLiveCustomerData: true,
    callsLiveProviders: true,
  };
  invalid.claimBoundaries.publicClaim = "Production hosted Yard is ready for all customers.";
  invalid.claimBoundaries.unsupportedClaim = "Hosted operations are production ready for all customers.";
  invalid.scopeIn.push("Provision live cloud resources and inspect live customer payloads.");

  const result = validateDogfoodPrivateBetaEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live customer data/i);
  assert.match(result.errors.join("\n"), /live provider/i);
  assert.match(result.errors.join("\n"), /publicClaim cannot promote/i);
  assert.match(result.errors.join("\n"), /unsupportedClaim cannot promote/i);
  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("work classifier routes adjacent implementation to owning projects", () => {
  assert.deepEqual(classifyDogfoodPrivateBetaWork("record private beta scenario fixture evidence"), {
    owner: "V1 Dogfood Yard & Hosted Operations",
    inScope: true,
  });
  assert.deepEqual(classifyDogfoodPrivateBetaWork("build hosted Yard runtime service"), {
    owner: "Hosted Operations Runtime",
    inScope: false,
  });
  assert.deepEqual(classifyDogfoodPrivateBetaWork("add admin dashboard navigation"), {
    owner: "Admin Console",
    inScope: false,
  });
  assert.deepEqual(classifyDogfoodPrivateBetaWork("call production provider API"), {
    owner: "Providers/IaC/Deploy Runtime",
    inScope: false,
  });
  assert.deepEqual(classifyDogfoodPrivateBetaWork("publish GA support promise"), {
    owner: "V1 Launch Support Desk & Escalation",
    inScope: false,
  });
});
