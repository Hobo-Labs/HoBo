import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  REQUIRED_INTAKE_FIELDS,
  REQUIRED_OPERATING_BOUNDARIES,
  REQUIRED_REVIEW_GATES,
  THREAT_MODEL_SECURITY_REVIEW_SCOPE,
  classifyThreatReviewFinding,
  canStartThreatReviewFollowUp,
  validateThreatModelSecurityReviewScope,
} from "../src/threat-model-security-review-scope.ts";

test("M0 scope record states the threat-model goal, personas, scope, and boundaries", () => {
  const result = validateThreatModelSecurityReviewScope(THREAT_MODEL_SECURITY_REVIEW_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(THREAT_MODEL_SECURITY_REVIEW_SCOPE.issue, "HOBO-451");
  assert.equal(THREAT_MODEL_SECURITY_REVIEW_SCOPE.phase, "M0");
  assert.match(THREAT_MODEL_SECURITY_REVIEW_SCOPE.goal, /Threat Model & Security Review/i);
  assert.deepEqual(
    THREAT_MODEL_SECURITY_REVIEW_SCOPE.personas.map((persona) => persona.id),
    [
      "security-reviewer",
      "release-owner",
      "product-owner",
      "support-operator",
      "customer-admin",
    ],
  );
  assert.deepEqual(
    THREAT_MODEL_SECURITY_REVIEW_SCOPE.operatingBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_OPERATING_BOUNDARIES].sort(),
  );
});

test("owning dependencies, intake fields, and review gates are explicit before follow-up work can start", () => {
  assert.deepEqual(
    THREAT_MODEL_SECURITY_REVIEW_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Threat Model & Security Review",
      "Security Verification",
      "V1 Release Program & Cutline",
      "V1 Launch Support Desk & Escalation",
      "Incident Communications",
      "V1 Legal, Privacy & Terms Readiness",
    ],
  );
  assert.deepEqual(
    THREAT_MODEL_SECURITY_REVIEW_SCOPE.intakeFields.map((field) => field.id).sort(),
    [...REQUIRED_INTAKE_FIELDS].sort(),
  );
  assert.deepEqual(
    THREAT_MODEL_SECURITY_REVIEW_SCOPE.reviewGates.map((gate) => gate.id).sort(),
    [...REQUIRED_REVIEW_GATES].sort(),
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  for (const phase of ["M1", "M2", "M3", "M4"] as const) {
    assert.equal(canStartThreatReviewFollowUp({ phase, m0Accepted: false }).allowed, false);
    assert.equal(canStartThreatReviewFollowUp({ phase, m0Accepted: true }).allowed, true);
  }

  assert.equal(canStartThreatReviewFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects scanner, exploit-runner, gate-bypass, and legal-copy creep", () => {
  const invalid = structuredClone(THREAT_MODEL_SECURITY_REVIEW_SCOPE);
  invalid.scopeIn.push("Implement a live scanner and exploit runner for tenant workloads.");
  invalid.scopeIn.push("Bypass release security gates when the reviewer accepts risk.");
  invalid.scopeIn.push("Publish final advisory copy and legal terms from this review package.");

  const result = validateThreatModelSecurityReviewScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live scanner/i);
  assert.match(result.errors.join("\n"), /gate bypass/i);
  assert.match(result.errors.join("\n"), /legal copy/i);
});

test("security findings classify customer-data and credential exposure as launch blockers", () => {
  assert.deepEqual(
    classifyThreatReviewFinding({
      severity: "critical",
      exploitability: "public",
      customerDataRisk: true,
      credentialExposure: false,
      fixVerified: false,
    }),
    {
      class: "launch-blocker",
      reason:
        "Critical or high exploitability, customer-data risk, credential exposure, or unverified release-affecting fix blocks launch.",
    },
  );

  assert.equal(
    classifyThreatReviewFinding({
      severity: "medium",
      exploitability: "bounded",
      customerDataRisk: false,
      credentialExposure: false,
      fixVerified: true,
    }).class,
    "high-risk-non-blocker",
  );
});

test("architecture evidence names schema, parsed types, and event boundary", () => {
  const architecture = readFileSync(new URL("../ARCHITECTURE.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../contracts/pacts/threat-model-security-review-scope.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(
    new URL("../proto/threat_model_security_review_scope.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(
    new URL("../cue/threat_model_security_review_scope.cue", import.meta.url),
    "utf8",
  );

  assert.equal(pact.consumer.name, "SecurityVerificationGate");
  assert.equal(pact.provider.name, "ThreatModelSecurityReviewScopeRecord");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "ThreatModelSecurityReviewScope",
    "ThreatReviewPersona",
    "ThreatReviewBoundary",
    "ThreatReviewIntakeField",
    "ThreatReviewGate",
    "ThreatReviewState",
  ]) {
    assert.match(proto, new RegExp(`(?:message|enum) ${typeName}`));
    assert.match(cue, new RegExp(`#${typeName}:`));
  }

  assert.match(architecture, /parse, don't validate/i);
  assert.match(architecture, /derived domain\s+types/i);
  assert.match(architecture, /Command/i);
  assert.match(architecture, /Events/i);
  assert.match(architecture, /Actor/i);
  assert.match(architecture, /event-store/i);
  assert.match(architecture, /projection/i);
  assert.match(architecture, /Snapshot/i);
  assert.match(architecture, /read store/i);
});
