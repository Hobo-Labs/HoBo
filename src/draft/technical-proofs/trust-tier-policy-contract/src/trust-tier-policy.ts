import { isJsonString, isJsonObject } from "./json.js";
export const TRUST_TIER_CONTRACT_VERSION = "hobo.trust-tier-policy/v1";

const TIER_RANK = Object.freeze({
  untrusted: 0,
  registered: 1,
  verified: 2,
  preferred: 3
});

const PROD_MIN_PROVENANCE_POLICY_ID = "deny-ceiling:prod-min-provenance-tier";

export function trustTier(listing) {
  const parsed = expectObject(listing, "listing");
  const provenanceTier = provenanceTierFor(parsed.provenance);
  const publisherIdentity = publisherIdentityFor(parsed.publisher);
  const ratingsTier = ratingsTierFor(parsed.ratings);

  return Object.freeze({
    contractVersion: TRUST_TIER_CONTRACT_VERSION,
    listingId: stringOrUnknown(parsed.id),
    tier: compositeTier({ provenanceTier, publisherIdentity, ratingsTier }),
    facts: Object.freeze({
      provenanceTier,
      publisherIdentity,
      ratingsTier
    }),
    caps: Object.freeze(capReasons({ provenanceTier, publisherIdentity }))
  });
}

export function createTrustPolicyProfile({
  profile = "dev",
  minProvenanceTier,
  actorId,
  reason
} = {}) {
  if (profile !== "prod") {
    return Object.freeze({ profile, policies: Object.freeze([]), auditEvents: Object.freeze([]) });
  }

  if (minProvenanceTier === "off") {
    return Object.freeze({
      profile,
      policies: Object.freeze([]),
      auditEvents: Object.freeze([
        Object.freeze({
          type: "trust.MinProvenanceTierDisabled",
          profile,
          actorId: requiredString(actorId, "actorId"),
          reason: requiredString(reason, "reason"),
          policyId: PROD_MIN_PROVENANCE_POLICY_ID
        })
      ])
    });
  }

  return Object.freeze({
    profile,
    policies: Object.freeze([
      Object.freeze({
        id: PROD_MIN_PROVENANCE_POLICY_ID,
        require: Object.freeze({ minTier: "verified" }),
        phase: "can-deploy",
        mandatory: true
      })
    ]),
    auditEvents: Object.freeze([])
  });
}

export function evaluateTrustTierPolicy({ listing, policy }) {
  const normalizedPolicy = normalizePolicy(policy);
  const evaluatedTrustTier = trustTier(listing);
  const passes = TIER_RANK[evaluatedTrustTier.tier] >= TIER_RANK[normalizedPolicy.minTier];
  return Object.freeze({
    contractVersion: TRUST_TIER_CONTRACT_VERSION,
    policyId: normalizedPolicy.id,
    decision: Object.freeze({
      effect: passes ? "allow" : "deny",
      reason: passes
        ? `listing meets required minTier ${normalizedPolicy.minTier}`
        : `listing trust tier ${evaluatedTrustTier.tier} is below required minTier ${normalizedPolicy.minTier}`,
      remediation: passes
        ? Object.freeze([])
        : Object.freeze([
            `select a listing with at least ${normalizedPolicy.minTier} trust`,
            "publish SLSA-3+ provenance with verified publisher identity",
            "use an equivalent conformance-certified listing"
          ]),
      evidence: Object.freeze({
        trustTier: evaluatedTrustTier,
        requiredMinTier: normalizedPolicy.minTier,
        phase: normalizedPolicy.phase
      })
    })
  });
}

function provenanceTierFor(provenance) {
  const parsed = expectObject(provenance, "listing.provenance");
  if (parsed.verified !== true) {
    return "unverified";
  }
  const level = Number.isInteger(parsed.slsaLevel) ? parsed.slsaLevel : 0;
  if (level >= 4) {
    return "slsa-4";
  }
  if (level >= 3) {
    return "slsa-3";
  }
  if (level >= 2) {
    return "slsa-2";
  }
  return "slsa-1";
}

function publisherIdentityFor(publisher) {
  const parsed = expectObject(publisher, "listing.publisher");
  return parsed.verified === true ? "verified" : "unverified";
}

function ratingsTierFor(ratings) {
  if (ratings === undefined) {
    return "limited";
  }
  const parsed = expectObject(ratings, "listing.ratings");
  const score = Number.isFinite(parsed.score) ? parsed.score : 0;
  const sampleSize = Number.isInteger(parsed.sampleSize) ? parsed.sampleSize : 0;
  if (score >= 4.5 && sampleSize >= 10) {
    return "strong";
  }
  if (score >= 4 && sampleSize >= 5) {
    return "positive";
  }
  return "limited";
}

function compositeTier({ provenanceTier, publisherIdentity, ratingsTier }) {
  if (provenanceTier === "slsa-4" && publisherIdentity === "verified" && ratingsTier === "strong") {
    return "preferred";
  }
  if (
    (provenanceTier === "slsa-3" || provenanceTier === "slsa-4") &&
    publisherIdentity === "verified"
  ) {
    return "verified";
  }
  if (provenanceTier !== "unverified" && publisherIdentity === "verified") {
    return "registered";
  }
  return "untrusted";
}

function capReasons({ provenanceTier, publisherIdentity }) {
  const caps = [];
  if (!["slsa-3", "slsa-4"].includes(provenanceTier)) {
    caps.push("provenance.below_verified");
  }
  if (publisherIdentity !== "verified") {
    caps.push("publisher.identity_unverified");
  }
  return caps;
}

function normalizePolicy(policy) {
  const parsed = expectObject(policy, "policy");
  const require = expectObject(parsed.require, "policy.require");
  const minTier = require.minTier;
  if (!Object.hasOwn(TIER_RANK, minTier)) {
    throw new TypeError("policy.require.minTier must be a known trust tier");
  }
  return Object.freeze({
    id: stringOrUnknown(parsed.id),
    minTier,
    phase: isJsonString(parsed.phase) && parsed.phase.length > 0 ? parsed.phase : "can-deploy"
  });
}

function expectObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function stringOrUnknown(value) {
  return isJsonString(value) && value.length > 0 ? value : "unknown";
}

function requiredString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}
