import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  REQUIRED_M1_EVIDENCE,
  REQUIRED_OPERATING_BOUNDARIES,
  SECURITY_VERIFICATION_SCOPE,
  canStartSecurityVerificationFollowUp,
  classifySecurityVerificationClaim,
  validateSecurityVerificationScope,
} from "../src/security-verification-scope.ts";

test("M0 scope record states the security-verification goal, personas, scope, and boundaries", () => {
  const result = validateSecurityVerificationScope(SECURITY_VERIFICATION_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(SECURITY_VERIFICATION_SCOPE.issue, "HOBO-441");
  assert.equal(SECURITY_VERIFICATION_SCOPE.phase, "M0");
  assert.match(SECURITY_VERIFICATION_SCOPE.goal, /Security Verification/i);
  assert.deepEqual(
    SECURITY_VERIFICATION_SCOPE.personas.map((persona) => persona.id),
    [
      "release-owner",
      "security-lead",
      "support-operator",
      "customer-admin",
      "legal-privacy-owner",
    ],
  );
  assert.deepEqual(
    SECURITY_VERIFICATION_SCOPE.operatingBoundaries.map((boundary) => boundary.id).sort(),
    [...REQUIRED_OPERATING_BOUNDARIES].sort(),
  );
});

test("owning dependencies and M1 evidence are explicit before follow-up work can start", () => {
  assert.deepEqual(
    SECURITY_VERIFICATION_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Security Verification",
      "Threat Model & Security Review",
      "V1 Release Program & Cutline",
      "V1 Launch Support Desk & Escalation",
      "Incident Communications",
      "V1 Legal, Privacy & Terms Readiness",
    ],
  );
  assert.deepEqual(
    SECURITY_VERIFICATION_SCOPE.m1Evidence.map((evidence) => evidence.id).sort(),
    [...REQUIRED_M1_EVIDENCE].sort(),
  );
});

test("M1-M4 follow-up issues stay blocked until M0 acceptance is recorded", () => {
  for (const phase of ["M1", "M2", "M3", "M4"] as const) {
    assert.equal(canStartSecurityVerificationFollowUp({ phase, m0Accepted: false }).allowed, false);
    assert.equal(canStartSecurityVerificationFollowUp({ phase, m0Accepted: true }).allowed, true);
  }

  assert.equal(canStartSecurityVerificationFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects live security-service and policy creep", () => {
  const invalid = structuredClone(SECURITY_VERIFICATION_SCOPE);
  invalid.scopeIn.push("Implement a live vulnerability scanner and SIEM integration.");
  invalid.scopeIn.push("Launch an external bug bounty and legal advisory terms.");
  invalid.scopeIn.push("Build the ticketing workflow and customer notification service.");

  const result = validateSecurityVerificationScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /live security service/i);
  assert.match(result.errors.join("\n"), /bug bounty/i);
  assert.match(result.errors.join("\n"), /ticketing workflow/i);
});

test("release-facing security claims require proof mode and source evidence", () => {
  assert.deepEqual(
    classifySecurityVerificationClaim({
      audience: "release-notes",
      claim: "HoBo has completed security verification for v1.",
    }),
    {
      allowed: false,
      reason: "Release-facing security verification claims require proof mode and source evidence.",
    },
  );

  assert.equal(
    classifySecurityVerificationClaim({
      audience: "release-notes",
      claim: "Security verification scope is accepted for M0 evidence.",
      proofMode: "contract-test",
      source: "src/draft/exp-proofs/dx/security-verification-scope-acceptance",
    }).allowed,
    true,
  );
});

test("architecture evidence names security schema, parsed types, and event boundary", () => {
  const architecture = readFileSync(new URL("../ADR.md", import.meta.url), "utf8");
  const pact = JSON.parse(
    readFileSync(
      new URL("../contracts/pacts/security-verification-scope.pact.json", import.meta.url),
      "utf8",
    ),
  );
  const proto = readFileSync(
    new URL("../proto/security_verification_scope.proto", import.meta.url),
    "utf8",
  );
  const cue = readFileSync(new URL("../cue/security_verification_scope.cue", import.meta.url), "utf8");

  assert.equal(pact.consumer.name, "ReleaseCutlineGate");
  assert.equal(pact.provider.name, "SecurityVerificationScopeRecord");
  assert.ok(pact.interactions.length >= 2);

  for (const typeName of [
    "SecurityVerificationScope",
    "SecurityVerificationPersona",
    "SecurityVerificationBoundary",
    "SecurityVerificationEvidence",
    "SecurityVerificationState",
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
