import assert from "node:assert/strict";
import { test } from "vitest";

import {
  MARKETPLACE_PUBLISHER_TRUST_EVIDENCE,
  REQUIRED_HANDOFFS,
  REQUIRED_TRUST_EVIDENCE,
  TRUST_TIERS,
  classifyLaunchDispositions,
  validateMarketplacePublisherTrustEvidence,
} from "../src/marketplace-publisher-trust-evidence.mjs";

test("M0 record defines publisher trust tiers and required review evidence", () => {
  const result = validateMarketplacePublisherTrustEvidence(MARKETPLACE_PUBLISHER_TRUST_EVIDENCE);

  assert.deepEqual(result.errors, []);
  assert.equal(MARKETPLACE_PUBLISHER_TRUST_EVIDENCE.issue, "HOBO-503");
  assert.equal(MARKETPLACE_PUBLISHER_TRUST_EVIDENCE.phase, "M0");
  assert.deepEqual(TRUST_TIERS, [
    "generated-sandbox",
    "verified-publisher",
    "hosted-curated",
    "enterprise-private",
  ]);
  assert.deepEqual(REQUIRED_TRUST_EVIDENCE, [
    "publisher-identity",
    "artifact-provenance",
    "conformance",
    "security-review",
    "deprecation-yank",
    "customer-warning",
  ]);
});

test("each trust tier maps evidence to registry, org catalog, provenance, and support handoffs", () => {
  for (const tier of MARKETPLACE_PUBLISHER_TRUST_EVIDENCE.trustTiers) {
    assert.ok(tier.customerWarning, `${tier.id} missing customer warning`);
    assert.ok(tier.publisherIdentity, `${tier.id} missing publisher identity`);
    assert.ok(tier.installDisposition, `${tier.id} missing install disposition`);
    assert.deepEqual(
      tier.evidence.map((item) => item.kind),
      REQUIRED_TRUST_EVIDENCE,
      `${tier.id} evidence kinds`,
    );
    assert.deepEqual(
      tier.handoffs.map((handoff) => handoff.kind),
      REQUIRED_HANDOFFS,
      `${tier.id} handoffs`,
    );
  }
});

test("unsupported marketplace claims are launch limitations with customer-visible wording", () => {
  assert.deepEqual(classifyLaunchDispositions(MARKETPLACE_PUBLISHER_TRUST_EVIDENCE), {
    installable: ["hosted-curated", "enterprise-private"],
    limitedBeta: ["generated-sandbox", "verified-publisher"],
    blocked: ["unreviewed-third-party", "paid-marketplace", "rating-as-safety-proof"],
  });

  for (const claim of MARKETPLACE_PUBLISHER_TRUST_EVIDENCE.unsupportedClaims) {
    assert.ok(claim.customerMessage, `${claim.id} missing customer message`);
    assert.ok(claim.ownerRoute, `${claim.id} missing owner route`);
    assert.match(claim.launchDisposition, /blocked|launch-limitation/);
  }
});

test("validation rejects marketplace UI, monetization, or evidence-less install claims", () => {
  const invalid = structuredClone(MARKETPLACE_PUBLISHER_TRUST_EVIDENCE);
  invalid.scopeIn.push("Build the marketplace review UI and paid publisher tiers.");
  invalid.trustTiers[0].evidence = invalid.trustTiers[0].evidence.filter(
    (item) => item.kind !== "security-review",
  );
  invalid.trustTiers[1].customerWarning = "";
  invalid.trustTiers[1].installDisposition = "installable";
  invalid.unsupportedClaims = invalid.unsupportedClaims.filter(
    (claim) => claim.id !== "unreviewed-third-party",
  );

  const result = validateMarketplacePublisherTrustEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /scope creep/i);
  assert.match(result.errors.join("\n"), /generated-sandbox missing evidence security-review/);
  assert.match(result.errors.join("\n"), /verified-publisher must include customer warning/);
  assert.match(result.errors.join("\n"), /verified-publisher cannot be installable without hosted or enterprise curation/);
  assert.match(result.errors.join("\n"), /missing unsupported claim unreviewed-third-party/);
});

test("adversarial guard prevents ratings, provenance, or identity from replacing review evidence", () => {
  const invalid = structuredClone(MARKETPLACE_PUBLISHER_TRUST_EVIDENCE);
  invalid.adversarialGuard = "";
  invalid.trustTiers[2].evidence = invalid.trustTiers[2].evidence.map((item) =>
    item.kind === "security-review"
      ? {
          ...item,
          source: "High rating plus signed provenance proves this publisher is safe.",
        }
      : item,
  );

  const result = validateMarketplacePublisherTrustEvidence(invalid);

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /adversarial guard is required/);
  assert.match(result.errors.join("\n"), /ratings or provenance cannot substitute for security review evidence/);
});
