import assert from "node:assert/strict";
import { test } from "vitest";

import {
  COMPLIANCE_EVIDENCE_PACK_SCOPE,
  REQUIRED_ASSURANCE_SECTIONS,
  REQUIRED_BOUNDARIES,
  REQUIRED_M1_EVIDENCE,
  REQUIRED_PERSONAS,
  canCreateComplianceEvidenceFollowUp,
  classifyComplianceEvidenceRequest,
  cloneMutableComplianceEvidencePackScope,
  validateComplianceEvidencePackScope,
} from "../src/compliance-evidence-pack-scope.ts";

test("M0 record names the compliance evidence pack goal, personas, and required assurance sections", () => {
  const result = validateComplianceEvidencePackScope(COMPLIANCE_EVIDENCE_PACK_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(COMPLIANCE_EVIDENCE_PACK_SCOPE.issue, "HOBO-452");
  assert.equal(COMPLIANCE_EVIDENCE_PACK_SCOPE.phase, "M0");
  assert.deepEqual(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.primaryPersonas.map((persona) => persona.id),
    REQUIRED_PERSONAS,
  );
  assert.ok(COMPLIANCE_EVIDENCE_PACK_SCOPE.scopeOut.length >= 5);
  assert.ok(COMPLIANCE_EVIDENCE_PACK_SCOPE.nonGoals.length >= 4);
  assert.deepEqual(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.assuranceSections.map((section) => section.id),
    REQUIRED_ASSURANCE_SECTIONS,
  );
});

test("each assurance section names owner, evidence source, beta state, GA state, and blocker route", () => {
  for (const section of COMPLIANCE_EVIDENCE_PACK_SCOPE.assuranceSections) {
    assert.ok(section.ownerProject, `${section.id} missing ownerProject`);
    assert.ok(section.sourceRecord, `${section.id} missing sourceRecord`);
    assert.ok(section.betaReadiness, `${section.id} missing betaReadiness`);
    assert.ok(section.gaReadiness, `${section.id} missing gaReadiness`);
    assert.ok(section.blockerRoute, `${section.id} missing blockerRoute`);
    assert.ok(section.customerSafeLimitation, `${section.id} missing customerSafeLimitation`);
  }
});

test("authoritative dependencies map service, UX, security, support, legal, and release boundaries", () => {
  assert.deepEqual(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.boundaries.map((boundary) => boundary.id),
    REQUIRED_BOUNDARIES,
  );
  for (const boundary of COMPLIANCE_EVIDENCE_PACK_SCOPE.boundaries) {
    assert.ok(boundary.owner, `${boundary.id} missing owner`);
    assert.ok(boundary.rule, `${boundary.id} missing rule`);
  }
  assert.deepEqual(COMPLIANCE_EVIDENCE_PACK_SCOPE.designRefs, [
    "docs/design/security-verification.md",
    "docs/design/tenant-data-lifecycle.md",
    "docs/design/sbom-vulnerability-notice-evidence.md",
    "docs/design/support-sla-channels.md",
    "docs/design/backup-restore.md",
    "docs/design/launch-blocker-taxonomy.md",
  ]);
  assert.deepEqual(COMPLIANCE_EVIDENCE_PACK_SCOPE.adrRefs, [
    "docs/design/adr/02-identity-security.md#adr-0023",
    "docs/design/adr/02-identity-security.md#adr-0060",
    "docs/design/adr/02-identity-security.md#adr-0074",
    "docs/design/adr/07-portability-extensibility.md#adr-0064",
  ]);
  assert.ok(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.owningInitiativeDependencies.some(
      (dependency) => dependency.owner === "Legal, Privacy & Terms Readiness",
    ),
  );
  assert.ok(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.owningInitiativeDependencies.some(
      (dependency) => dependency.owner === "Security Verification",
    ),
  );
  assert.ok(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.owningInitiativeDependencies.some(
      (dependency) => dependency.owner === "Support Workflow",
    ),
  );
});

test("M1 evidence gate blocks follow-up implementation until M0 scope is accepted", () => {
  assert.deepEqual(
    COMPLIANCE_EVIDENCE_PACK_SCOPE.m1Evidence.map((evidence) => evidence.id),
    REQUIRED_M1_EVIDENCE,
  );
  assert.equal(canCreateComplianceEvidenceFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateComplianceEvidenceFollowUp({ phase: "M4", m0Accepted: false }).allowed, false);
  assert.equal(canCreateComplianceEvidenceFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateComplianceEvidenceFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("request classifier routes adjacent legal, security, data, support, and release work to owners", () => {
  assert.equal(
    classifyComplianceEvidenceRequest("assemble customer assurance packet and gap register").owner,
    "Compliance Evidence Pack",
  );
  assert.equal(
    classifyComplianceEvidenceRequest("approve final DPA, subprocessors, and privacy terms").owner,
    "Legal, Privacy & Terms Readiness",
  );
  assert.equal(
    classifyComplianceEvidenceRequest("verify vulnerability report and break-glass audit finding").owner,
    "Security Verification",
  );
  assert.equal(
    classifyComplianceEvidenceRequest("define tenant data deletion and residency retention matrix").owner,
    "Tenant Data Lifecycle",
  );
  assert.equal(
    classifyComplianceEvidenceRequest("build support escalation playbook for customer response").owner,
    "Support Workflow",
  );
  assert.equal(
    classifyComplianceEvidenceRequest("decide beta launch blocker exception and go/no-go cutline").owner,
    "V1 Release Program & Cutline",
  );
});

test("validation rejects scope creep into legal approval, live systems, and proofless customer claims", () => {
  const invalid = cloneMutableComplianceEvidencePackScope();
  invalid.goal = "";
  invalid.primaryPersonas = invalid.primaryPersonas.filter(
    (persona) => persona.id !== "customer-security-reviewer",
  );
  invalid.scopeOut = [];
  invalid.nonGoals = [];
  invalid.boundaries = invalid.boundaries.filter((boundary) => boundary.id !== "ux");
  invalid.scopeIn.push("Approve final DPA and subprocessor list for customers.");
  invalid.scopeIn.push("Implement live compliance portal and scanner integrations.");
  invalid.scopeIn.push("Grant support access to production customer data.");
  invalid.scopeIn.push("Publish customer-facing compliance certification without linked evidence.");
  invalid.assuranceSections[0] = {
    ...invalid.assuranceSections[0],
    sourceRecord: "",
  };
  invalid.assuranceSections = invalid.assuranceSections.filter(
    (section) => section.id !== "tenant-data-lifecycle",
  );

  const result = validateComplianceEvidencePackScope(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /user\/business goal/);
  assert.match(result.errors.join("\n"), /missing primary persona customer-security-reviewer/);
  assert.match(result.errors.join("\n"), /scopeOut must be recorded/);
  assert.match(result.errors.join("\n"), /nonGoals must be recorded/);
  assert.match(result.errors.join("\n"), /missing ux boundary/);
  assert.match(result.errors.join("\n"), /legal approval/i);
  assert.match(result.errors.join("\n"), /live compliance implementation/i);
  assert.match(result.errors.join("\n"), /support data access/i);
  assert.match(result.errors.join("\n"), /proofless customer claim/i);
  assert.match(result.errors.join("\n"), /missing assurance section tenant-data-lifecycle/);
  assert.match(result.errors.join("\n"), /security-posture missing sourceRecord/);
});
