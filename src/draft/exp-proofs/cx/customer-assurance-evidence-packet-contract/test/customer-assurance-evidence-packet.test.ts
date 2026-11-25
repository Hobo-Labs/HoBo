import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CUSTOMER_ASSURANCE_EVIDENCE_PACKET,
  canCreateCustomerAssuranceFollowUp,
  classifyCustomerAssuranceWork,
  cloneMutableCustomerAssuranceEvidencePacket,
  validateCustomerAssuranceEvidencePacket,
} from "../src/customer-assurance-evidence-packet.ts";

test("M0 packet records every customer assurance section with owner and readiness state", () => {
  const result = validateCustomerAssuranceEvidencePacket(CUSTOMER_ASSURANCE_EVIDENCE_PACKET);

  assert.deepEqual(result.errors, []);
  assert.equal(CUSTOMER_ASSURANCE_EVIDENCE_PACKET.issue, "HOBO-493");
  assert.equal(CUSTOMER_ASSURANCE_EVIDENCE_PACKET.phase, "M0");
  assert.deepEqual(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.sections.map((section) => section.id),
    [
      "dpa-needs",
      "subprocessors-providers",
      "data-flow-summary",
      "control-summary",
      "security-evidence",
      "backup-dr-evidence",
      "support-obligations",
      "known-gaps",
    ],
  );
  assert.equal(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.sections.every(
      (section) => section.owner && section.sourceEvidence && section.betaReadiness && section.gaReadiness,
    ),
    true,
  );
});

test("unavailable legal artifacts are blockers or explicit launch limitations", () => {
  assert.ok(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.legalArtifacts.some(
      (artifact) => artifact.id === "dpa-template" && artifact.availability === "unavailable",
    ),
  );
  assert.equal(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.legalArtifacts.every(
      (artifact) =>
        artifact.availability !== "unavailable" ||
        artifact.disposition === "launch-blocker" ||
        artifact.disposition === "explicit-launch-limitation",
    ),
    true,
  );

  const missingDpaDisposition = {
    ...CUSTOMER_ASSURANCE_EVIDENCE_PACKET,
    legalArtifacts: CUSTOMER_ASSURANCE_EVIDENCE_PACKET.legalArtifacts.filter((artifact) => artifact.id !== "dpa-template"),
  };

  assert.match(
    validateCustomerAssuranceEvidencePacket(missingDpaDisposition).errors.join("\n"),
    /Missing legal artifact disposition: dpa-template/,
  );
});

test("authoritative dependencies link legal, privacy, security, backup, support, and tenant data handoffs", () => {
  assert.deepEqual(CUSTOMER_ASSURANCE_EVIDENCE_PACKET.designRefs, [
    "docs/design/legal-privacy-terms-readiness.md",
    "docs/design/tenant-data-lifecycle.md",
    "docs/design/security-verification.md",
    "docs/design/backup-restore.md",
    "docs/design/support-sla-channels.md",
    "docs/design/provenance-retention.md",
  ]);
  assert.ok(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.initiativeDependencies.some(
      (dependency) => dependency.owner === "Legal, Privacy & Terms Readiness",
    ),
  );
  assert.ok(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.initiativeDependencies.some(
      (dependency) => dependency.owner === "Security Verification",
    ),
  );
  assert.ok(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.initiativeDependencies.some(
      (dependency) => dependency.owner === "Backup & Restore",
    ),
  );
  assert.ok(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.initiativeDependencies.some(
      (dependency) => dependency.owner === "Support Workflow",
    ),
  );
});

test("M1 follow-up gate blocks assurance implementation until M0 packet acceptance", () => {
  assert.deepEqual(
    CUSTOMER_ASSURANCE_EVIDENCE_PACKET.m1Evidence.map((evidence) => evidence.id),
    [
      "assurance-packet-outline",
      "source-evidence-register",
      "legal-artifact-disposition",
      "customer-facing-claim-map",
      "support-escalation-handoff",
      "scope-boundary-register",
    ],
  );
  assert.equal(canCreateCustomerAssuranceFollowUp({ phase: "M1", m0Accepted: false }).allowed, false);
  assert.equal(canCreateCustomerAssuranceFollowUp({ phase: "M3", m0Accepted: false }).allowed, false);
  assert.equal(canCreateCustomerAssuranceFollowUp({ phase: "M1", m0Accepted: true }).allowed, true);
  assert.equal(canCreateCustomerAssuranceFollowUp({ phase: "M0", m0Accepted: false }).allowed, true);
});

test("scope validation rejects final legal approval or proofless public claims", () => {
  const invalid = cloneMutableCustomerAssuranceEvidencePacket();
  invalid.scopeIn.push("Approve final DPA and publish legal terms.");
  invalid.scopeIn.push("Publish SOC2 compliance claims without evidence.");
  invalid.scopeIn.push("Approve subprocessor list without legal owner signoff.");

  const result = validateCustomerAssuranceEvidencePacket(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /legal approval/i);
  assert.match(result.errors.join("\n"), /proofless public claim/i);
  assert.match(result.errors.join("\n"), /subprocessor approval/i);
});

test("work classifier routes adjacent assurance work to owning initiatives", () => {
  assert.equal(
    classifyCustomerAssuranceWork("customer assurance packet source evidence register").owner,
    "Compliance Evidence Pack",
  );
  assert.equal(classifyCustomerAssuranceWork("final DPA and privacy notice approval").owner, "Legal, Privacy & Terms Readiness");
  assert.equal(classifyCustomerAssuranceWork("security claim evidence and vulnerability process").owner, "Security Verification");
  assert.equal(classifyCustomerAssuranceWork("backup restore drill and DR evidence").owner, "Backup & Restore");
  assert.equal(classifyCustomerAssuranceWork("support escalation and customer request routing").owner, "Support Workflow");
});
