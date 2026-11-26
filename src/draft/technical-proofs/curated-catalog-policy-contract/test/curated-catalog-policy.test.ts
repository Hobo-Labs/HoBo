import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createCuratedCatalog,
  createFixtureBindle,
  createFixtureCertifiedListing,
  createHostedDefaultCatalog,
  createPreApprovedOnlyProdPolicy,
  evaluateCatalogSelection,
  revokeCatalogListing,
} from "../src/curated-catalog-policy.js";

test("catalog definition emits listing.Approved for fixture certified listings", () => {
  const catalog = createCuratedCatalog({
    id: "catalog:yard-prod/providers",
    name: "Yard prod providers",
    tier: "slsa-build-l3",
    policyPin: "policy-pack:prod-preapproved-only@sha256:1111",
    listings: [
      createFixtureCertifiedListing({
        listingId: "listing-postgres",
        digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      }),
      createFixtureCertifiedListing({
        listingId: "listing-redis",
        digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      }),
    ],
    actor: "yard:hosted-hobo",
    occurredAt: "2026-06-26T08:30:00.000Z",
  });

  assert.equal(catalog.id, "catalog:yard-prod/providers");
  assert.equal(catalog.tier, "slsa-build-l3");
  assert.equal(catalog.policyPin, "policy-pack:prod-preapproved-only@sha256:1111");
  assert.deepEqual(
    catalog.approvedListings.map((listing) => listing.listingId),
    ["listing-postgres", "listing-redis"],
  );
  assert.deepEqual(
    catalog.events.map((event) => ({
      type: event.type,
      catalogId: event.catalogId,
      listingId: event.listingId,
      policyPin: event.policyPin,
    })),
    [
      {
        type: "listing.Approved",
        catalogId: "catalog:yard-prod/providers",
        listingId: "listing-postgres",
        policyPin: "policy-pack:prod-preapproved-only@sha256:1111",
      },
      {
        type: "listing.Approved",
        catalogId: "catalog:yard-prod/providers",
        listingId: "listing-redis",
        policyPin: "policy-pack:prod-preapproved-only@sha256:1111",
      },
    ],
  );
});

test("prod pre-approved-only policy allows approved listings and hard-denies others", () => {
  const policy = createPreApprovedOnlyProdPolicy({
    id: "policy:prod/catalog-only",
    catalogId: "catalog:hosted/default",
  });
  const approved = createFixtureCertifiedListing({ listingId: "listing-approved" });
  const nonApproved = createFixtureCertifiedListing({ listingId: "listing-shadow" });
  const catalog = createCuratedCatalog({
    id: "catalog:hosted/default",
    tier: "slsa-build-l3",
    policyPin: policy.pin,
    listings: [approved],
  });

  const allowed = evaluateCatalogSelection({
    catalog,
    policy,
    environment: "prod",
    bindle: createFixtureBindle({ listingId: approved.listingId }),
    requestedListing: approved,
  });
  const denied = evaluateCatalogSelection({
    catalog,
    policy,
    environment: "prod",
    bindle: createFixtureBindle({ listingId: nonApproved.listingId }),
    requestedListing: nonApproved,
  });

  assert.equal(allowed.ok, true, allowed.remediation);
  assert.equal(allowed.decision.effect, "allow");
  assert.equal(allowed.decision.reason, "listing is pre-approved for prod");

  assert.equal(denied.ok, false);
  assert.equal(denied.decision.effect, "deny");
  assert.match(denied.decision.reason, /pre-approved catalog/);
  assert.match(denied.remediation, /catalog:hosted\/default/);
  assert.equal(
    denied.events.find((event) => event.type === "catalog.SelectionDenied")?.policyId,
    policy.id,
  );
});

test("prod selection is pinned to catalog policy and approved digest", () => {
  const policy = createPreApprovedOnlyProdPolicy({
    id: "policy:prod/catalog-only",
    catalogId: "catalog:hosted/default",
  });
  const approved = createFixtureCertifiedListing({
    listingId: "listing-approved",
    digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  const catalog = createCuratedCatalog({
    id: "catalog:hosted/default",
    tier: "slsa-build-l3",
    policyPin: policy.pin,
    listings: [approved],
  });

  const digestSubstitution = evaluateCatalogSelection({
    catalog,
    policy,
    environment: "prod",
    bindle: createFixtureBindle({ listingId: approved.listingId }),
    requestedListing: {
      ...approved,
      digest: "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    },
  });
  const stalePolicyPin = evaluateCatalogSelection({
    catalog,
    policy: createPreApprovedOnlyProdPolicy({
      id: "policy:prod/catalog-only",
      catalogId: catalog.id,
      pin: "policy-pack:prod-preapproved-only@sha256:stale",
    }),
    environment: "prod",
    bindle: createFixtureBindle({ listingId: approved.listingId }),
    requestedListing: approved,
  });

  assert.equal(digestSubstitution.ok, false);
  assert.match(digestSubstitution.decision.reason, /pre-approved catalog/);
  assert.match(digestSubstitution.remediation, /listing.Approved/);

  assert.equal(stalePolicyPin.ok, false);
  assert.match(stalePolicyPin.decision.reason, /policy pin/);
  assert.match(stalePolicyPin.remediation, /policy-pinned catalog/);
});

test("listing.Revoked removes approvals from new selection without rewriting deployed Sets", () => {
  const policy = createPreApprovedOnlyProdPolicy({
    id: "policy:prod/catalog-only",
    catalogId: "catalog:hosted/default",
  });
  const listing = createFixtureCertifiedListing({ listingId: "listing-revoked" });
  const catalog = createCuratedCatalog({
    id: "catalog:hosted/default",
    tier: "slsa-build-l3",
    policyPin: policy.pin,
    listings: [listing],
  });

  const revoke = revokeCatalogListing({
    catalog,
    listingId: listing.listingId,
    actor: "yard-security-admin",
    reason: "provider conformance regression",
    severity: "critical",
    occurredAt: "2026-06-26T09:00:00.000Z",
    deployedSets: [
      {
        setId: "set:checkout-prod",
        bindleId: "bindle:checkout",
        listingId: listing.listingId,
        deploymentRevision: 42,
      },
    ],
  });

  const afterRevoke = evaluateCatalogSelection({
    catalog: revoke.catalog,
    policy,
    environment: "prod",
    bindle: createFixtureBindle({ listingId: listing.listingId }),
    requestedListing: listing,
  });

  assert.equal(revoke.event.type, "listing.Revoked");
  assert.deepEqual(revoke.catalog.approvedListings, []);
  assert.deepEqual(revoke.runningSetSignals, [
    {
      type: "catalog.RunningSetFlagged",
      setId: "set:checkout-prod",
      bindleId: "bindle:checkout",
      listingId: listing.listingId,
      deploymentRevision: 42,
      severity: "critical",
      forcedRewrite: false,
    },
  ]);
  assert.equal(afterRevoke.ok, false);
  assert.match(afterRevoke.remediation, /Select an approved listing/);
});

test("hosted default catalog lets fixture Bindle deploy without extra approval", () => {
  const bindle = createFixtureBindle({
    bindleId: "bindle:hello-hobo",
    listingId: "listing-hosted-web",
  });
  const catalog = createHostedDefaultCatalog({
    listings: [
      createFixtureCertifiedListing({
        listingId: "listing-hosted-web",
        name: "@hobo/hosted-web",
      }),
    ],
  });

  const result = evaluateCatalogSelection({
    catalog,
    policy: createPreApprovedOnlyProdPolicy({
      id: "policy:hosted/default-prod",
      catalogId: catalog.id,
      pin: catalog.policyPin,
    }),
    environment: "prod",
    bindle,
    requestedListing: catalog.approvedListings[0],
  });

  assert.equal(catalog.id, "catalog:hosted-hobo/default");
  assert.equal(result.ok, true, result.remediation);
  assert.equal(result.decision.requiresPerItemApproval, false);
  assert.equal(result.deployment.bindleId, "bindle:hello-hobo");
});

test("approval cannot bypass signature or conformance verification", () => {
  assert.throws(
    () =>
      createCuratedCatalog({
        id: "catalog:hosted/default",
        tier: "slsa-build-l3",
        policyPin: "policy-pack:prod-preapproved-only@sha256:1111",
        listings: [
          createFixtureCertifiedListing({
            listingId: "listing-unsigned",
            signature: { verified: false },
          }),
        ],
      }),
    /signature verification/,
  );

  assert.throws(
    () =>
      createCuratedCatalog({
        id: "catalog:hosted/default",
        tier: "slsa-build-l3",
        policyPin: "policy-pack:prod-preapproved-only@sha256:1111",
        listings: [
          createFixtureCertifiedListing({
            listingId: "listing-failed-conformance",
            conformance: { status: "failed", suiteId: "@hobo/conformance/provider@1.0.0" },
          }),
        ],
      }),
    /passing conformance/,
  );
});

test("catalog tier cannot vouch for a listing below that tier", () => {
  assert.throws(
    () =>
      createCuratedCatalog({
        id: "catalog:hosted/default",
        tier: "slsa-build-l3",
        policyPin: "policy-pack:prod-preapproved-only@sha256:1111",
        listings: [
          createFixtureCertifiedListing({
            listingId: "listing-low-tier",
            provenanceTier: "sandboxed-builder",
          }),
        ],
      }),
    /below catalog tier/,
  );
});

test("pre-approved-only policy is environment scoped and still records catalog evidence outside prod", () => {
  const policy = createPreApprovedOnlyProdPolicy({
    id: "policy:prod/catalog-only",
    catalogId: "catalog:hosted/default",
  });
  const listing = createFixtureCertifiedListing({ listingId: "listing-dev-only" });
  const catalog = createCuratedCatalog({
    id: "catalog:hosted/default",
    tier: "slsa-build-l3",
    policyPin: policy.pin,
    listings: [],
  });

  const result = evaluateCatalogSelection({
    catalog,
    policy,
    environment: "dev",
    bindle: createFixtureBindle({ listingId: listing.listingId }),
    requestedListing: listing,
  });

  assert.equal(result.ok, true);
  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.reason, "pre-approved-only policy does not apply outside prod");
  assert.deepEqual(result.decision.evidence.catalog, {
    catalogId: "catalog:hosted/default",
    listingApproved: false,
    policyPin: policy.pin,
  });
});
