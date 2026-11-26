import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createTrustPolicyProfile,
  evaluateTrustTierPolicy,
  trustTier
} from "../src/trust-tier-policy.js";

test("trustTier is deterministic and derived only from listing facts", () => {
  const listing = certifiedListing({
    provenance: { slsaLevel: 3, source: "github-actions", verified: true },
    publisher: { id: "publisher:acme", verified: true },
    ratings: { score: 4.8, sampleSize: 24 }
  });

  const first = trustTier(listing);
  const second = trustTier({
    ...listing,
    cost: { monthlyUsd: 0 },
    commercialTier: "enterprise",
    ratings: { sampleSize: 24, score: 4.8 },
    publisher: { verified: true, id: "publisher:acme" },
    provenance: { verified: true, source: "github-actions", slsaLevel: 3 }
  });

  assert.deepEqual(first, second);
  assert.equal(first.tier, "verified");
  assert.deepEqual(first.facts, {
    provenanceTier: "slsa-3",
    publisherIdentity: "verified",
    ratingsTier: "strong"
  });
  assert.equal(Object.hasOwn(first, "cost"), false);
  assert.equal(Object.hasOwn(first, "commercialTier"), false);
});

test("require minTier policy denies below-tier listings with remediation and passes at-or-above", () => {
  const policy = {
    id: "policy:prod-min-trust",
    require: { minTier: "verified" },
    phase: "can-deploy"
  };

  const belowTier = evaluateTrustTierPolicy({
    listing: certifiedListing({
      provenance: { slsaLevel: 2, source: "github-actions", verified: true },
      publisher: { id: "publisher:acme", verified: true },
      ratings: { score: 5, sampleSize: 100 }
    }),
    policy
  });
  const atTier = evaluateTrustTierPolicy({ listing: certifiedListing(), policy });

  assert.equal(belowTier.decision.effect, "deny");
  assert.match(belowTier.decision.reason, /below required minTier verified/);
  assert.deepEqual(belowTier.decision.remediation, [
    "select a listing with at least verified trust",
    "publish SLSA-3+ provenance with verified publisher identity",
    "use an equivalent conformance-certified listing"
  ]);

  assert.equal(atTier.decision.effect, "allow");
  assert.equal(atTier.decision.evidence.trustTier.tier, "verified");
});

test("prod profile ships min-provenance-tier default-on and disabling it emits audit", () => {
  const prod = createTrustPolicyProfile({ profile: "prod" });
  const disabled = createTrustPolicyProfile({
    profile: "prod",
    minProvenanceTier: "off",
    actorId: "user:security-admin",
    reason: "temporary incident exception"
  });

  assert.equal(prod.policies[0].id, "deny-ceiling:prod-min-provenance-tier");
  assert.equal(prod.policies[0].require.minTier, "verified");
  assert.equal(prod.auditEvents.length, 0);

  assert.deepEqual(disabled.policies, []);
  assert.deepEqual(disabled.auditEvents, [
    {
      type: "trust.MinProvenanceTierDisabled",
      profile: "prod",
      actorId: "user:security-admin",
      reason: "temporary incident exception",
      policyId: "deny-ceiling:prod-min-provenance-tier"
    }
  ]);
});

test("missing ratings degrade to limited instead of failing selection", () => {
  const listing = certifiedListing({
    ratings: undefined
  });

  const tier = trustTier(listing);

  assert.equal(tier.tier, "verified");
  assert.equal(tier.facts.ratingsTier, "limited");
});

test("ratings cannot substitute for provenance and unverified publisher identity caps tier", () => {
  const highRatedLowProvenance = trustTier(
    certifiedListing({
      provenance: { slsaLevel: 1, source: "manual-upload", verified: true },
      publisher: { id: "publisher:acme", verified: true },
      ratings: { score: 5, sampleSize: 500 }
    })
  );
  const unverifiedPublisher = trustTier(
    certifiedListing({
      provenance: { slsaLevel: 4, source: "github-actions", verified: true },
      publisher: { id: "publisher:unknown", verified: false },
      ratings: { score: 5, sampleSize: 500 }
    })
  );

  assert.equal(highRatedLowProvenance.tier, "registered");
  assert.deepEqual(highRatedLowProvenance.caps, ["provenance.below_verified"]);

  assert.equal(unverifiedPublisher.tier, "untrusted");
  assert.deepEqual(unverifiedPublisher.caps, ["publisher.identity_unverified"]);
});

function certifiedListing(overrides = {}) {
  return {
    id: "listing:provider-postgres",
    version: "1.0.0",
    kind: "provider",
    status: "Certified",
    provenance: { slsaLevel: 3, source: "github-actions", verified: true },
    publisher: { id: "publisher:acme", verified: true },
    ratings: { score: 4.8, sampleSize: 24 },
    ...overrides
  };
}
