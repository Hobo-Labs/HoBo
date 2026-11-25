import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CAPABILITY_REVIEW_APPROVAL_SCOPE,
  REQUIRED_BOUNDARIES,
  canCreateCapabilityReviewFollowUp,
  validateCapabilityReviewApprovalScope,
} from "../src/capability-review-approval-scope.mjs";

test("M0 record states goal, personas, scope, non-goals, and operating boundaries", () => {
  const result = validateCapabilityReviewApprovalScope(CAPABILITY_REVIEW_APPROVAL_SCOPE);

  assert.deepEqual(result.errors, []);
  assert.equal(CAPABILITY_REVIEW_APPROVAL_SCOPE.issue, "HOBO-423");
  assert.equal(CAPABILITY_REVIEW_APPROVAL_SCOPE.phase, "M0");
  assert.match(CAPABILITY_REVIEW_APPROVAL_SCOPE.goal, /capability review/i);
  assert.match(CAPABILITY_REVIEW_APPROVAL_SCOPE.goal, /approval/i);
  assert.deepEqual(
    CAPABILITY_REVIEW_APPROVAL_SCOPE.personas.map((persona) => persona.role),
    [
      "marketplace operator",
      "security reviewer",
      "platform engineer",
      "publisher owner",
      "support operator",
    ],
  );
  assert.deepEqual(Object.keys(CAPABILITY_REVIEW_APPROVAL_SCOPE.boundaries), REQUIRED_BOUNDARIES);
  assert.ok(CAPABILITY_REVIEW_APPROVAL_SCOPE.scopeIn.length >= 5);
  assert.ok(CAPABILITY_REVIEW_APPROVAL_SCOPE.scopeOut.length >= 5);
});

test("M0 record maps dependencies to authoritative design sources", () => {
  assert.deepEqual(
    CAPABILITY_REVIEW_APPROVAL_SCOPE.dependencies.map((dependency) => dependency.source),
    [
      "docs/design/marketplace-publisher-trust-evidence.md",
      "docs/design/sbom-vulnerability-notice-evidence.md",
      "docs/design/adr/07-portability-extensibility.md#adr-0062",
      "docs/design/adr/02-identity-security.md#adr-0074",
      "docs/design/adr/07-portability-extensibility.md#adr-0075",
      "src/draft/technical-proofs/curated-catalog-policy-contract/README.md",
      "src/draft/technical-proofs/trust-tier-policy-contract/README.md",
    ],
  );
});

test("M0 record maps owning initiative dependencies without taking their scope", () => {
  assert.deepEqual(
    CAPABILITY_REVIEW_APPROVAL_SCOPE.initiativeDependencies.map((dependency) => dependency.owner),
    [
      "Capability Review & Approval",
      "Publisher Portal",
      "Marketplace UX",
      "Org Catalogs",
      "Registry Distribution",
      "Security Verification",
      "Support Workflow",
      "V1 Release Program & Cutline",
    ],
  );
  assert.equal(
    CAPABILITY_REVIEW_APPROVAL_SCOPE.initiativeDependencies.every(
      (dependency) => dependency.consumes && dependency.scopeBoundary,
    ),
    true,
  );
});

test("M0 record lists review states and evidence required before M1 contract proof", () => {
  assert.deepEqual(CAPABILITY_REVIEW_APPROVAL_SCOPE.reviewStates, [
    "submitted",
    "triage",
    "evidence-required",
    "approved-limited-beta",
    "approved-installable",
    "rejected",
    "yanked",
    "escalated",
  ]);
  assert.deepEqual(
    CAPABILITY_REVIEW_APPROVAL_SCOPE.m1Evidence.map((evidence) => evidence.kind),
    [
      "review-queue-state-model",
      "approval-policy-matrix",
      "trust-tier-evidence-fixture",
      "security-conformance-checklist",
      "yank-escalation-handoff",
      "rating-signal-boundary",
    ],
  );
  assert.equal(
    CAPABILITY_REVIEW_APPROVAL_SCOPE.m1Evidence.every(
      (evidence) => evidence.owner && evidence.proofMode && evidence.source && evidence.proves,
    ),
    true,
  );
});

test("follow-up implementation issues stay blocked until M0 acceptance is recorded", () => {
  assert.equal(canCreateCapabilityReviewFollowUp({ phase: "M1", m0Accepted: false }), false);
  assert.equal(canCreateCapabilityReviewFollowUp({ phase: "M2", m0Accepted: false }), false);
  assert.equal(canCreateCapabilityReviewFollowUp({ phase: "M1", m0Accepted: true }), true);
  assert.equal(canCreateCapabilityReviewFollowUp({ phase: "M0", m0Accepted: true }), false);
});

test("scope validation rejects review UI, monetization, live registry, scanner, policy-engine, or trust-badge creep", () => {
  const result = validateCapabilityReviewApprovalScope({
    ...CAPABILITY_REVIEW_APPROVAL_SCOPE,
    scopeIn: [
      ...CAPABILITY_REVIEW_APPROVAL_SCOPE.scopeIn,
      "Build marketplace review UI, paid publisher payout flows, live Registry storage, security scanner integration, policy engine enforcement, and trust badge rendering.",
    ],
  });

  assert.match(result.errors.join("\n"), /scope creep/i);
});

test("scope validation fails closed when required review evidence is removed", () => {
  const result = validateCapabilityReviewApprovalScope({
    ...CAPABILITY_REVIEW_APPROVAL_SCOPE,
    reviewStates: CAPABILITY_REVIEW_APPROVAL_SCOPE.reviewStates.filter(
      (state) => state !== "approved-limited-beta",
    ),
    approvalOutcomes: CAPABILITY_REVIEW_APPROVAL_SCOPE.approvalOutcomes.filter(
      (outcome) => outcome.id !== "limited-beta",
    ),
    m1Evidence: CAPABILITY_REVIEW_APPROVAL_SCOPE.m1Evidence.filter(
      (evidence) => evidence.kind !== "rating-signal-boundary",
    ),
  });

  assert.match(result.errors.join("\n"), /review state missing: approved-limited-beta/i);
  assert.match(result.errors.join("\n"), /approval outcome missing: limited-beta/i);
  assert.match(result.errors.join("\n"), /m1 evidence missing: rating-signal-boundary/i);
});

test("approval evidence cannot make customer-visible installability claims without proof source and owner route", () => {
  const result = validateCapabilityReviewApprovalScope({
    ...CAPABILITY_REVIEW_APPROVAL_SCOPE,
    m1Evidence: [
      ...CAPABILITY_REVIEW_APPROVAL_SCOPE.m1Evidence,
      {
        kind: "installability-claim",
        owner: "marketplace operator",
        proofMode: "contract-test",
        proves: "Capabilities are safe to install.",
      },
    ],
    approvalOutcomes: [
      ...CAPABILITY_REVIEW_APPROVAL_SCOPE.approvalOutcomes,
      {
        id: "safe-install",
        customerVisible: true,
      },
    ],
  });

  assert.match(result.errors.join("\n"), /source/i);
  assert.match(result.errors.join("\n"), /customer-visible approval outcome/i);
});
