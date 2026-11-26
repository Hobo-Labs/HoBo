import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createFixtureListing,
  createPortabilitySwapRegistry,
  createPortableBindle,
} from "../src/portability-swap-equivalent.js";

test("swaps a pinned dependency to a conformance-equivalent listing without app code changes or tier checks", () => {
  const source = createFixtureListing({
    listingId: "listing-host-a",
    name: "@acme/host-a",
    trustTier: "enterprise",
    commercialTier: "paid",
  });
  const target = createFixtureListing({
    listingId: "listing-host-b",
    name: "@open/host-b",
    trustTier: "community",
    commercialTier: "free",
  });
  const registry = createPortabilitySwapRegistry([source, target]);
  const bindle = createPortableBindle({ dependency: source });

  const result = registry.swapForEquivalent({
    bindle,
    fromListingId: source.listingId,
    toListingId: target.listingId,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "Swapped");
  assert.equal(result.bindle.appSourceDigest, bindle.appSourceDigest);
  assert.equal(result.bindle.dependencies[0].listingId, target.listingId);
  assert.equal(result.bindle.dependencies[0].interfaceRef, source.interfaces[0].ref);
  assert.deepEqual(result.gatesChecked, ["interface", "conformance"]);
  assert.equal(result.tierGateApplied, false);
});

test("refuses swap candidates that fail the same conformance suite", () => {
  const source = createFixtureListing({ listingId: "listing-host-a" });
  const failedCandidate = createFixtureListing({
    listingId: "listing-host-broken",
    name: "@bad/host",
    certification: {
      status: "failed",
      suite: "@hobo/conformance/component-host",
      suiteVersion: "1.0.0",
    },
  });
  const registry = createPortabilitySwapRegistry([source, failedCandidate]);
  const bindle = createPortableBindle({ dependency: source });

  const result = registry.swapForEquivalent({
    bindle,
    fromListingId: source.listingId,
    toListingId: failedCandidate.listingId,
  });

  assert.equal(result.ok, false);
  assert.equal(result.status, "Refused");
  assert.deepEqual(result.reasons, ["candidate.conformance_failed"]);
  assert.deepEqual(result.bindle, bindle);
});

test("routes to generation when no listed equivalent exists", () => {
  const source = createFixtureListing({ listingId: "listing-only-host" });
  const registry = createPortabilitySwapRegistry([source]);
  const bindle = createPortableBindle({ dependency: source });

  const result = registry.swapForEquivalent({
    bindle,
    fromListingId: source.listingId,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "GenerationRequired");
  assert.deepEqual(result.bindle, bindle);
  assert.equal(result.generationRequest.interfaceRef, source.interfaces[0].ref);
  assert.equal(result.generationRequest.requiredSuite, "@hobo/conformance/component-host@1.0.0");
  assert.equal(result.generationRequest.reason, "no-listed-conformance-equivalent");
});

test("automatic swap routing ignores failed candidates and routes to generation", () => {
  const source = createFixtureListing({ listingId: "listing-host-a" });
  const failedCandidate = createFixtureListing({
    listingId: "listing-host-failed",
    certification: {
      status: "failed",
      suite: "@hobo/conformance/component-host",
      suiteVersion: "1.0.0",
    },
  });
  const registry = createPortabilitySwapRegistry([source, failedCandidate]);

  const result = registry.swapForEquivalent({
    bindle: createPortableBindle({ dependency: source }),
    fromListingId: source.listingId,
  });

  assert.equal(result.ok, true);
  assert.equal(result.status, "GenerationRequired");
  assert.equal(result.generationRequest.reason, "no-listed-conformance-equivalent");
});

test("import and export stay available for every listing regardless of trust or commercial tier", () => {
  const source = createFixtureListing({
    listingId: "listing-paid-host",
    trustTier: "low",
    commercialTier: "paid",
  });
  const sourceRegistry = createPortabilitySwapRegistry([source]);
  const exported = sourceRegistry.exportListing(source.listingId, {
    callerTier: "free",
    requireTrustTier: "enterprise",
  });

  assert.equal(exported.ok, true);
  assert.equal(exported.listing.listingId, source.listingId);
  assert.equal(exported.gatedByTier, false);

  const targetRegistry = createPortabilitySwapRegistry();
  const imported = targetRegistry.importListing(exported.listing, {
    callerTier: "free",
    requireTrustTier: "enterprise",
  });

  assert.equal(imported.ok, true);
  assert.equal(imported.listing.listingId, source.listingId);
  assert.equal(imported.gatedByTier, false);
  assert.deepEqual(targetRegistry.listings().map((listing) => listing.listingId), [source.listingId]);
});

test("a higher-trust source cannot block a lower-trust conformance-equivalent candidate", () => {
  const source = createFixtureListing({
    listingId: "listing-enterprise-host",
    trustTier: "enterprise",
  });
  const lowerTrustEquivalent = createFixtureListing({
    listingId: "listing-community-host",
    name: "@community/host",
    trustTier: "community",
  });
  const registry = createPortabilitySwapRegistry([source, lowerTrustEquivalent]);

  const result = registry.swapForEquivalent({
    bindle: createPortableBindle({ dependency: source }),
    fromListingId: source.listingId,
    toListingId: lowerTrustEquivalent.listingId,
  });

  assert.equal(result.ok, true);
  assert.equal(result.bindle.dependencies[0].listingId, lowerTrustEquivalent.listingId);
  assert.equal(result.tierGateApplied, false);
});
