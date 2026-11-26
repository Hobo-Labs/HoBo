/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse untrusted catalog fixture values before policy evaluation. */
import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const CURATED_CATALOG_SCHEMA_VERSION = "hobo.curated-catalog/v1";
export const PRE_APPROVED_ONLY_POLICY_KIND = "hobo.policy.pre-approved-catalog-only/v1";

const PROVENANCE_TIER_ORDER = Object.freeze([
  "builder-observed",
  "sandboxed-builder",
  "slsa-build-l3",
]);

export function createFixtureCertifiedListing(overrides = {}) {
  const listingId = overrides.listingId ?? "listing-fixture-web";
  return {
    listingId,
    kind: overrides.kind ?? "provider",
    name: overrides.name ?? `@hobo/${listingId.replace(/^listing-/, "")}`,
    version: overrides.version ?? "1.0.0",
    digest: overrides.digest ?? digestOf(listingId),
    status: overrides.status ?? "Certified",
    provenanceTier: overrides.provenanceTier ?? "slsa-build-l3",
    signature: {
      verified: true,
      keyId: "key:hosted-hobo-builder",
      ...overrides.signature,
    },
    certification: {
      status: "passed",
      reportRef: `oci://registry.example/hobo/reports/${listingId}@${digestOf(`report:${listingId}`)}`,
      ...overrides.certification,
    },
    conformance: {
      status: "passed",
      suiteId: "@hobo/conformance/provider@1.0.0",
      ...overrides.conformance,
    },
  };
}

export function createFixtureBindle(overrides = {}) {
  const listingId = overrides.listingId ?? "listing-fixture-web";
  return Object.freeze({
    bindleId: overrides.bindleId ?? "bindle:fixture",
    name: overrides.name ?? "fixture-bindle",
    requestedListingId: listingId,
    declaredCatalogId: overrides.declaredCatalogId ?? null,
  });
}

export function createPreApprovedOnlyProdPolicy({
  id = "policy:prod/pre-approved-catalog-only",
  catalogId,
  environments = ["prod"],
  pin,
} = {}) {
  assertNonEmptyString(catalogId, "catalogId");
  const normalizedEnvironments = uniqueNonEmptyStrings(environments, "environments");
  return Object.freeze({
    id,
    kind: PRE_APPROVED_ONLY_POLICY_KIND,
    catalogId,
    environments: Object.freeze(normalizedEnvironments),
    pin: pin ?? `${id}@sha256:${shortHash({ id, catalogId, environments: normalizedEnvironments })}`,
    requiresPreApprovedListing: true,
  });
}

export function createCuratedCatalog({
  id,
  name,
  tier,
  policyPin,
  listings,
  actor = "yard:fixture",
  occurredAt = "2026-06-26T08:00:00.000Z",
}) {
  assertNonEmptyString(id, "id");
  assertKnownTier(tier, "tier");
  assertNonEmptyString(policyPin, "policyPin");
  assertArray(listings, "listings");

  const approvedListings = listings.map((listing, index) =>
    approveListing({
      listing,
      catalogId: id,
      catalogTier: tier,
      policyPin,
      actor,
      occurredAt,
      path: `listings[${index}]`,
    }),
  );

  return freezeCatalog({
    schemaVersion: CURATED_CATALOG_SCHEMA_VERSION,
    id,
    name: name ?? id,
    tier,
    policyPin,
    approvedListings: approvedListings.map((approval) => approval.listing),
    revokedListings: [],
    events: approvedListings.map((approval) => approval.event),
  });
}

export function createHostedDefaultCatalog({
  listings,
  actor = "yard:hosted-hobo",
  occurredAt = "2026-06-26T08:00:00.000Z",
} = {}) {
  return createCuratedCatalog({
    id: "catalog:hosted-hobo/default",
    name: "Hosted HoBo default catalog",
    tier: "slsa-build-l3",
    policyPin: "policy-pack:hosted-hobo/prod-pre-approved-only@sha256:hosted-default",
    listings: listings ?? [createFixtureCertifiedListing({ listingId: "listing-hosted-web" })],
    actor,
    occurredAt,
  });
}

export function revokeCatalogListing({
  catalog,
  listingId,
  actor,
  reason,
  severity = "medium",
  occurredAt = "2026-06-26T09:00:00.000Z",
  deployedSets = [],
}) {
  const source = normalizeCatalog(catalog, "catalog");
  assertNonEmptyString(listingId, "listingId");
  assertNonEmptyString(actor, "actor");
  assertNonEmptyString(reason, "reason");
  assertArray(deployedSets, "deployedSets");

  const revoked = source.approvedListings.find((listing) => listing.listingId === listingId);
  const event = Object.freeze({
    type: "listing.Revoked",
    schemaVersion: CURATED_CATALOG_SCHEMA_VERSION,
    catalogId: source.id,
    listingId,
    listingDigest: revoked?.digest ?? null,
    policyPin: source.policyPin,
    actor,
    reason,
    severity,
    occurredAt,
  });

  const nextCatalog = freezeCatalog({
    ...source,
    approvedListings: source.approvedListings.filter((listing) => listing.listingId !== listingId),
    revokedListings: [
      ...source.revokedListings,
      {
        listingId,
        digest: revoked?.digest ?? null,
        reason,
        severity,
        revokedAt: occurredAt,
      },
    ],
    events: [...source.events, event],
  });

  return Object.freeze({
    event,
    catalog: nextCatalog,
    runningSetSignals: Object.freeze(
      deployedSets
        .filter((set) => set?.listingId === listingId)
        .map((set) => Object.freeze({
          type: "catalog.RunningSetFlagged",
          setId: requireString(set.setId, "deployedSets[].setId"),
          bindleId: requireString(set.bindleId, "deployedSets[].bindleId"),
          listingId,
          deploymentRevision: set.deploymentRevision,
          severity,
          forcedRewrite: false,
        })),
    ),
  });
}

export function evaluateCatalogSelection({
  catalog,
  policy,
  environment,
  bindle,
  requestedListing,
}) {
  const normalizedCatalog = normalizeCatalog(catalog, "catalog");
  const normalizedPolicy = normalizePolicy(policy);
  assertNonEmptyString(environment, "environment");
  const normalizedBindle = normalizeBindle(bindle);
  const listing = normalizeSelectionListing(requestedListing, normalizedBindle);
  const approval = findApproval(normalizedCatalog, listing);
  const catalogEvidence = {
    catalogId: normalizedCatalog.id,
    listingApproved: approval !== null,
    policyPin: normalizedPolicy.pin,
  };

  if (!normalizedPolicy.environments.includes(environment)) {
    return allowedDecision({
      catalog: normalizedCatalog,
      policy: normalizedPolicy,
      bindle: normalizedBindle,
      listing,
      reason: "pre-approved-only policy does not apply outside prod",
      catalogEvidence,
    });
  }

  if (normalizedPolicy.catalogId !== normalizedCatalog.id) {
    return deniedDecision({
      catalog: normalizedCatalog,
      policy: normalizedPolicy,
      bindle: normalizedBindle,
      listing,
      reason: `pre-approved catalog policy is pinned to ${normalizedPolicy.catalogId}, not ${normalizedCatalog.id}`,
      remediation: `Deploy through the policy-pinned catalog ${normalizedPolicy.catalogId}, or update the prod policy pack through governance.`,
      catalogEvidence,
    });
  }

  if (normalizedPolicy.pin !== normalizedCatalog.policyPin) {
    return deniedDecision({
      catalog: normalizedCatalog,
      policy: normalizedPolicy,
      bindle: normalizedBindle,
      listing,
      reason: "pre-approved catalog policy pin does not match the selected catalog",
      remediation: `Select the policy-pinned catalog snapshot ${normalizedPolicy.pin}, or publish a new policy pack pin for ${normalizedCatalog.id}.`,
      catalogEvidence,
    });
  }

  if (!catalogEvidence.listingApproved) {
    return deniedDecision({
      catalog: normalizedCatalog,
      policy: normalizedPolicy,
      bindle: normalizedBindle,
      listing,
      reason: "listing is not in the policy-pinned pre-approved catalog",
      remediation: `Select an approved listing from ${normalizedCatalog.id}, or request a listing.Approved event for ${listing.listingId}.`,
      catalogEvidence,
    });
  }

  return allowedDecision({
    catalog: normalizedCatalog,
    policy: normalizedPolicy,
    bindle: normalizedBindle,
    listing,
    reason: "listing is pre-approved for prod",
    catalogEvidence,
  });
}

function approveListing({ listing, catalogId, catalogTier, policyPin, actor, occurredAt, path }) {
  const normalized = normalizeCertifiedListing(listing, path);
  if (tierRank(normalized.provenanceTier) < tierRank(catalogTier)) {
    throw new RangeError(`${path}.provenanceTier is below catalog tier ${catalogTier}`);
  }

  const approved = Object.freeze({
    listingId: normalized.listingId,
    kind: normalized.kind,
    name: normalized.name,
    version: normalized.version,
    digest: normalized.digest,
    provenanceTier: normalized.provenanceTier,
  });

  return {
    listing: approved,
    event: Object.freeze({
      type: "listing.Approved",
      schemaVersion: CURATED_CATALOG_SCHEMA_VERSION,
      catalogId,
      listingId: approved.listingId,
      listingDigest: approved.digest,
      listingTier: approved.provenanceTier,
      catalogTier,
      policyPin,
      actor,
      occurredAt,
    }),
  };
}

function normalizeCertifiedListing(input, path) {
  const listing = expectObject(input, path);
  const normalized = {
    listingId: requireString(listing.listingId, `${path}.listingId`),
    kind: requireString(listing.kind ?? "provider", `${path}.kind`),
    name: requireString(listing.name, `${path}.name`),
    version: requireString(listing.version, `${path}.version`),
    digest: requireString(listing.digest, `${path}.digest`),
    status: requireString(listing.status, `${path}.status`),
    provenanceTier: requireString(listing.provenanceTier, `${path}.provenanceTier`),
    signature: expectObject(listing.signature, `${path}.signature`),
    certification: expectObject(listing.certification, `${path}.certification`),
    conformance: expectObject(listing.conformance, `${path}.conformance`),
  };
  assertKnownTier(normalized.provenanceTier, `${path}.provenanceTier`);

  if (normalized.status !== "Certified") {
    throw new Error(`${path} must be Certified before catalog approval`);
  }
  if (normalized.signature.verified !== true) {
    throw new Error(`${path} requires signature verification before catalog approval`);
  }
  if (normalized.certification.status !== "passed") {
    throw new Error(`${path} requires passed certification before catalog approval`);
  }
  if (normalized.conformance.status !== "passed") {
    throw new Error(`${path} requires passing conformance before catalog approval`);
  }

  return normalized;
}

function normalizeSelectionListing(input, bindle) {
  if (!input) {
    return {
      listingId: bindle.requestedListingId,
      digest: null,
      provenanceTier: null,
    };
  }
  const listing = expectObject(input, "requestedListing");
  return {
    listingId: requireString(listing.listingId, "requestedListing.listingId"),
    digest: isJsonString(listing.digest) ? listing.digest : null,
    provenanceTier: isJsonString(listing.provenanceTier) ? listing.provenanceTier : null,
  };
}

function normalizeBindle(input) {
  const bindle = expectObject(input, "bindle");
  return {
    bindleId: requireString(bindle.bindleId, "bindle.bindleId"),
    requestedListingId: requireString(bindle.requestedListingId, "bindle.requestedListingId"),
  };
}

function normalizePolicy(input) {
  const policy = expectObject(input, "policy");
  if (policy.kind !== PRE_APPROVED_ONLY_POLICY_KIND) {
    throw new Error("policy.kind must be hobo.policy.pre-approved-catalog-only/v1");
  }
  return {
    id: requireString(policy.id, "policy.id"),
    kind: policy.kind,
    catalogId: requireString(policy.catalogId, "policy.catalogId"),
    environments: uniqueNonEmptyStrings(policy.environments, "policy.environments"),
    pin: requireString(policy.pin, "policy.pin"),
    requiresPreApprovedListing: policy.requiresPreApprovedListing === true,
  };
}

function normalizeCatalog(input, path) {
  const catalog = expectObject(input, path);
  return {
    schemaVersion: requireString(catalog.schemaVersion, `${path}.schemaVersion`),
    id: requireString(catalog.id, `${path}.id`),
    name: requireString(catalog.name, `${path}.name`),
    tier: requireString(catalog.tier, `${path}.tier`),
    policyPin: requireString(catalog.policyPin, `${path}.policyPin`),
    approvedListings: [...expectArray(catalog.approvedListings, `${path}.approvedListings`)],
    revokedListings: [...expectArray(catalog.revokedListings, `${path}.revokedListings`)],
    events: [...expectArray(catalog.events, `${path}.events`)],
  };
}

function allowedDecision({
  catalog,
  policy,
  bindle,
  listing,
  reason,
  catalogEvidence,
}) {
  const event = {
    type: "catalog.SelectionAllowed",
    catalogId: catalog.id,
    listingId: listing.listingId,
    policyId: policy.id,
    bindleId: bindle.bindleId,
    requiresPerItemApproval: false,
  };

  return Object.freeze({
    ok: true,
    decision: Object.freeze({
      effect: "allow",
      reason,
      requiresPerItemApproval: false,
      evidence: Object.freeze({
        catalog: Object.freeze(catalogEvidence),
      }),
    }),
    remediation: undefined,
    events: Object.freeze([Object.freeze(event)]),
    deployment: Object.freeze({
      bindleId: bindle.bindleId,
      listingId: listing.listingId,
      catalogId: catalog.id,
      policyPin: policy.pin,
    }),
  });
}

function deniedDecision({
  catalog,
  policy,
  bindle,
  listing,
  reason,
  remediation,
  catalogEvidence,
}) {
  const event = {
    type: "catalog.SelectionDenied",
    catalogId: catalog.id,
    listingId: listing.listingId,
    policyId: policy.id,
    bindleId: bindle.bindleId,
    remediation,
  };

  return Object.freeze({
    ok: false,
    decision: Object.freeze({
      effect: "deny",
      reason,
      requiresPerItemApproval: false,
      evidence: Object.freeze({
        catalog: Object.freeze(catalogEvidence),
      }),
    }),
    remediation,
    events: Object.freeze([Object.freeze(event)]),
    deployment: null,
  });
}

function findApproval(catalog, requestedListing) {
  const approval = catalog.approvedListings.find((listing) => listing.listingId === requestedListing.listingId);
  if (!approval) {
    return null;
  }
  if (requestedListing.digest !== null && requestedListing.digest !== approval.digest) {
    return null;
  }
  return approval;
}

function freezeCatalog(catalog) {
  return Object.freeze({
    ...catalog,
    approvedListings: Object.freeze(catalog.approvedListings.map((listing) => Object.freeze({ ...listing }))),
    revokedListings: Object.freeze(catalog.revokedListings.map((listing) => Object.freeze({ ...listing }))),
    events: Object.freeze(catalog.events.map((event) => Object.freeze({ ...event }))),
  });
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array`);
  }
}

function expectArray(value, name) {
  assertArray(value, name);
  return value;
}

function expectObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, name) {
  requireString(value, name);
}

function requireString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  return value;
}

function assertKnownTier(value, name) {
  if (!PROVENANCE_TIER_ORDER.includes(value)) {
    throw new TypeError(`${name} must be one of ${PROVENANCE_TIER_ORDER.join(", ")}`);
  }
}

function tierRank(value) {
  return PROVENANCE_TIER_ORDER.indexOf(value);
}

function uniqueNonEmptyStrings(values, name) {
  assertArray(values, name);
  const normalized = [...new Set(values.map((value, index) => requireString(value, `${name}[${index}]`)))];
  if (normalized.length === 0) {
    throw new TypeError(`${name} must contain at least one value`);
  }
  return normalized;
}

function digestOf(seed) {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

function shortHash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function stableStringify(value) {
  if (value === null || !isJsonObject(value)) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}
