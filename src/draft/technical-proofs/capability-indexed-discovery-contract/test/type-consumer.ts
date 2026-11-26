import assert from "node:assert/strict";
import { test } from "vitest";

import type {
  CapabilityDiscoveryIndex,
  CapabilityDiscoveryQuery,
  ListingCertifiedEvent,
} from "../src/capability-indexed-discovery.js";
import {
  CAPABILITY_DISCOVERY_CONTRACT,
  createCapabilityDiscoveryIndex,
  createDiscoveryMcpTool,
  createFixtureCertifiedListing,
} from "../src/capability-indexed-discovery.js";

test("typed consumer can drive SDK and MCP discovery paths", async () => {
  const index: CapabilityDiscoveryIndex = createCapabilityDiscoveryIndex();
  const descriptor = createFixtureCertifiedListing({ listingId: "listing-typed-consumer" });
  const event: ListingCertifiedEvent = {
    type: "listing.Certified",
    listingId: descriptor.listingId,
    descriptor,
    certification: { status: "passed" },
  };
  const query: CapabilityDiscoveryQuery = {
    port: "wasi:blobstore/blobstore@1.0.0",
    criteria: { region: "us-east-1", classification: "public" },
  };

  index.apply(event);
  const sdkResult = index.find(query);
  const mcpResult = await createDiscoveryMcpTool(index).invoke(query);

  assert.equal(sdkResult.contract, CAPABILITY_DISCOVERY_CONTRACT);
  assert.deepEqual(mcpResult, sdkResult);
  assert.equal(index.entries()[0].listingId, "listing-typed-consumer");
});
