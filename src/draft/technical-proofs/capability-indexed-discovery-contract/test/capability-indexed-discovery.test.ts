import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  CAPABILITY_DISCOVERY_CONTRACT,
  createCapabilityDiscoveryIndex,
  createDiscoveryMcpTool,
  createFixtureCertifiedListing,
} from "../src/capability-indexed-discovery.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("query by WIT port returns only certified listings implementing it", () => {
  const index = createCapabilityDiscoveryIndex();
  index.apply(certified({
    listingId: "listing-blob-stable",
    providerId: "acme-blob",
    interfaces: [blobstoreStable()],
  }));
  index.apply(certified({
    listingId: "listing-websocket",
    providerId: "acme-websocket",
    interfaces: [websocketStable()],
  }));

  const result = index.find({ port: "wasi:blobstore/blobstore@1.0.0" });

  assert.equal(result.ok, true);
  assert.equal(result.contract, CAPABILITY_DISCOVERY_CONTRACT);
  assert.deepEqual(result.results.map((listing) => listing.listingId), ["listing-blob-stable"]);
  assert.equal(result.results[0].capability.interface, "wasi:blobstore/blobstore");
  assert.equal(result.results[0].capability.semver, "1.0.0");
  assert.equal(result.results[0].capability.stability, "stable");
});

test("region and classification filters narrow results strictly", () => {
  const index = createCapabilityDiscoveryIndex();
  index.apply(certified({
    listingId: "listing-us-public",
    providerId: "acme-us",
    matching: { regions: ["us-east-1"], classifications: ["public"] },
  }));
  index.apply(certified({
    listingId: "listing-eu-restricted",
    providerId: "acme-eu",
    matching: { regions: ["eu-west-1"], classifications: ["restricted"] },
  }));
  index.apply(certified({
    listingId: "listing-us-no-classification",
    providerId: "acme-us-unknown",
    matching: { regions: ["us-east-1"], classifications: [] },
  }));

  const result = index.find({
    port: "wasi:blobstore/blobstore@1.0.0",
    criteria: { region: "us-east-1", classification: "public" },
  });

  assert.deepEqual(result.results.map((listing) => listing.listingId), ["listing-us-public"]);
});

test("SDK API and MCP tool return identical discovery results", async () => {
  const index = createCapabilityDiscoveryIndex();
  index.apply(certified({
    listingId: "listing-agent-driveable",
    providerId: "acme-agent",
  }));
  const query = {
    port: "wasi:blobstore/blobstore@1.0.0",
    criteria: { region: "us-east-1", classification: "public" },
  };
  const tool = createDiscoveryMcpTool(index);

  const sdkResult = index.find(query);
  const mcpResult = await tool.invoke(query);

  assert.equal(tool.name, "hobo_find_capability_listings");
  assert.deepEqual(mcpResult, sdkResult);
});

test("certified listings enter the index and yanked listings leave new selections", () => {
  const index = createCapabilityDiscoveryIndex();
  const event = certified({ listingId: "listing-lifecycle", providerId: "acme-lifecycle" });

  index.apply(event);
  assert.deepEqual(index.find({ port: "wasi:blobstore/blobstore@1.0.0" }).results.map((listing) => listing.listingId), [
    "listing-lifecycle",
  ]);

  index.apply({
    type: "listing.Yanked",
    listingId: "listing-lifecycle",
    reason: "capability spec regression",
    occurredAt: "2026-06-25T13:00:00.000Z",
  });

  const afterYank = index.find({ port: "wasi:blobstore/blobstore@1.0.0" });
  assert.deepEqual(afterYank.results, []);
  assert.match(afterYank.remediation, /conformance-certified/);
});

test("empty discovery is a successful result with remediation, not an error", () => {
  const index = createCapabilityDiscoveryIndex();

  const result = index.find({ port: "wasi:queue/queue@1.0.0" });

  assert.equal(result.ok, true);
  assert.deepEqual(result.results, []);
  assert.match(result.remediation, /No certified listing implements wasi:queue\/queue@1\.0\.0/);
});

test("uncertified or unlisted artifacts never appear in discovery", () => {
  const index = createCapabilityDiscoveryIndex();
  index.apply({
    type: "listing.Published",
    listingId: "listing-published-only",
    descriptor: createFixtureCertifiedListing({ listingId: "listing-published-only" }),
  });
  index.apply({
    type: "listing.Certified",
    listingId: "listing-bad-certification",
    descriptor: createFixtureCertifiedListing({ listingId: "listing-bad-certification" }),
    certification: { status: "failed" },
  });

  const result = index.find({ port: "wasi:blobstore/blobstore@1.0.0" });

  assert.deepEqual(result.results, []);
});

test("schema-free type declarations publish the discovery contract surface", async () => {
  const typeDeclarations = await readFile(
    path.join(packageRoot, "src", "capability-indexed-discovery.d.ts"),
    "utf8",
  );

  assert.match(typeDeclarations, /export interface CapabilityDiscoveryIndex/);
  assert.match(typeDeclarations, /export function createDiscoveryMcpTool/);
  assert.match(typeDeclarations, /listing\.Certified/);
  assert.match(typeDeclarations, /listing\.Yanked/);
});

function certified(overrides = {}) {
  return {
    type: "listing.Certified",
    occurredAt: "2026-06-25T12:00:00.000Z",
    listingId: overrides.listingId,
    descriptor: createFixtureCertifiedListing(overrides),
    certification: { status: "passed", reportRef: `oci://registry.example/reports/${overrides.listingId ?? "fixture"}@sha256:1111111111111111111111111111111111111111111111111111111111111111` },
  };
}

function blobstoreStable() {
  return {
    interface: "wasi:blobstore/blobstore",
    semver: "1.0.0",
    stability: "stable",
  };
}

function websocketStable() {
  return {
    interface: "wasi:websocket/websocket",
    semver: "1.0.0",
    stability: "stable",
  };
}
