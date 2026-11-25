import assert from "node:assert/strict";
import { test } from "vitest";

import {
  LEGAL_PRIVACY_TERMS_READINESS,
  canCreateLaunchFollowUp,
  classifyUnknowns,
  validateLaunchChecklist,
} from "../src/legal-privacy-terms-readiness.mjs";

test("checklist covers launch legal, privacy, support, communications, and evidence domains", () => {
  const result = validateLaunchChecklist(LEGAL_PRIVACY_TERMS_READINESS);

  assert.deepEqual(result.errors, []);
  assert.equal(LEGAL_PRIVACY_TERMS_READINESS.issue, "HOBO-405");
  assert.equal(LEGAL_PRIVACY_TERMS_READINESS.phase, "M0");
  assert.deepEqual(
    LEGAL_PRIVACY_TERMS_READINESS.checklist.map((item) => item.domain),
    [
      "terms",
      "privacy-notice",
      "data-retention",
      "telemetry",
      "subprocessors-provider-claims",
      "security-claims",
      "support-obligations",
      "customer-communications",
    ],
  );
});

test("every checklist item names an owner, owning project, evidence, customer message, and entitlement impact", () => {
  for (const item of LEGAL_PRIVACY_TERMS_READINESS.checklist) {
    assert.ok(item.owner, `${item.domain} owner`);
    assert.ok(item.owningProject, `${item.domain} owning project`);
    assert.ok(item.evidenceSource, `${item.domain} evidence source`);
    assert.ok(item.customerVisibleMessage, `${item.domain} customer message`);
    assert.ok(item.entitlementImpact, `${item.domain} entitlement impact`);
  }
});

test("open unknowns are classified as launch blockers or explicit post-v1 follow-ups", () => {
  assert.deepEqual(classifyUnknowns(LEGAL_PRIVACY_TERMS_READINESS), {
    blockers: [
      "final-legal-review",
      "subprocessor-list-confirmation",
      "security-claim-evidence-review",
    ],
    postV1: [
      "localized-terms",
      "formal-compliance-certification",
    ],
  });
});

test("design dependencies reference security, compliance, governance, and scope records", () => {
  assert.deepEqual(
    LEGAL_PRIVACY_TERMS_READINESS.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/security-networking.md#plan-12",
      "docs/design/governance-planes.md#plan-46",
      "docs/design/adr/02-identity-security.md#adr-0023",
      "docs/design/adr/02-identity-security.md#adr-0060",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/07-portability-extensibility.md#adr-0064",
    ],
  );
});

test("launch follow-up work stays blocked until this M0 checklist is accepted", () => {
  assert.equal(canCreateLaunchFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateLaunchFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateLaunchFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateLaunchFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("validation rejects checklist items without owner or owning project", () => {
  const checklist = LEGAL_PRIVACY_TERMS_READINESS.checklist.map((item) =>
    item.domain === "terms" ? { ...item, owner: "", owningProject: "" } : item,
  );

  const result = validateLaunchChecklist({
    ...LEGAL_PRIVACY_TERMS_READINESS,
    checklist,
  });

  assert.match(result.errors.join("\n"), /terms must name owner and owning project/);
});

test("validation rejects public compliance claims without evidence", () => {
  const checklist = [
    ...LEGAL_PRIVACY_TERMS_READINESS.checklist,
    {
      domain: "security-claims",
      title: "SOC2 claim",
      owner: "launch owner",
      owningProject: "V1 Launch Site, Messaging & Demo Assets",
      status: "unsupported",
      customerVisibleMessage: "HoBo is SOC2 certified.",
      evidenceSource: "",
      entitlementImpact: "none",
      supportAction: "remove claim",
      auditEvidence: "missing",
      claimType: "public-compliance-claim",
    },
  ];

  const result = validateLaunchChecklist({
    ...LEGAL_PRIVACY_TERMS_READINESS,
    checklist,
  });

  assert.match(result.errors.join("\n"), /public compliance claim requires evidence/);
});

test("validation rejects final legal drafting or unclassified unknowns in this M0 scope", () => {
  const result = validateLaunchChecklist({
    ...LEGAL_PRIVACY_TERMS_READINESS,
    scopeIn: [
      ...LEGAL_PRIVACY_TERMS_READINESS.scopeIn,
      "Draft final customer terms and privacy policy text for publication.",
    ],
    unknowns: [
      ...LEGAL_PRIVACY_TERMS_READINESS.unknowns,
      {
        id: "unclassified-risk",
        question: "Who signs the public claims?",
        disposition: "unknown",
        owner: "launch owner",
      },
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
  assert.match(result.errors.join("\n"), /unknown unclassified-risk must be blocker or post-v1/);
});
