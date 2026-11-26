import assert from "node:assert/strict";
import { test } from "vitest";

import {
  createInternalServiceDirectory,
  createProviderEndpoint,
} from "../src/internal-service-discovery.js";

const now = "2026-06-28T12:00:00.000Z";

test("resolves a stable logical endpoint without exposing hardcoded provider hosts", () => {
  const directory = fixtureDirectory();

  const binding = directory.resolveBinding("api");

  assert.deepEqual(binding, {
    logicalName: "shop.api",
    camp: "prod-us",
    tenant: "tenant-acme",
    endpointRef: "internal-endpoint://prod-us/shop/api",
    identityRef: "spiffe://yard/tenant-acme/shop/api",
  });
  assert.equal(JSON.stringify(binding).includes("10.0.0.10"), false);
  assert.equal(JSON.stringify(binding).includes("api.internal.aws"), false);
});

test("discovers a cross-provider peer through SVID identity instead of DNS round-robin", () => {
  const directory = fixtureDirectory();

  const connection = directory.discoverPeer({
    from: "api",
    to: "db",
    now,
  });

  assert.equal(connection.ok, true);
  assert.equal(connection.discoveryPath, "svid-identity");
  assert.equal(connection.transport, "mtls");
  assert.deepEqual(connection.providers, {
    from: "aws",
    to: "azure",
  });
  assert.equal(connection.peer.logicalName, "shop.db");
  assert.equal(connection.peer.endpointRef, "internal-endpoint://prod-us/shop/db");
  assert.equal(JSON.stringify(connection).includes("db-public.example.com"), false);
  assert.equal(connection.authz.bindEdgeId, "shop.api->shop.db");
});

test("endpoint address changes are transparent to app-facing bindings", () => {
  const directory = fixtureDirectory();
  const before = directory.resolveBinding("db");

  directory.updateProviderEndpoint("db", createProviderEndpoint({
    host: "db.internal.azure.rebalanced",
    address: "10.2.4.9",
    port: 443,
  }));

  const after = directory.resolveBinding("db");
  const runtimeAddress = directory.inspectRuntimeEndpoint("db");

  assert.deepEqual(after, before);
  assert.deepEqual(runtimeAddress, {
    host: "db.internal.azure.rebalanced",
    address: "10.2.4.9",
    port: 443,
  });
});

test("unknown logical names fail closed", () => {
  const directory = fixtureDirectory();

  assert.deepEqual(directory.discoverPeer({
    from: "api",
    to: "payments",
    now,
  }), {
    ok: false,
    code: "internal-discovery.unknown-logical-name",
    reason: "unknown logical resource shop.payments",
  });
});

test("public DNS records are not a fallback when identity discovery cannot authenticate", () => {
  const directory = fixtureDirectory();
  directory.registerResource({
    name: "cache",
    provider: "cloudflare",
    region: "global",
    endpoint: createProviderEndpoint({
      host: "cache.public.example.com",
      address: "198.51.100.12",
      port: 443,
    }),
    publicDnsRecords: ["cache.public.example.com"],
  });
  directory.bind({ from: "api", to: "cache", verbs: ["connect"] });

  assert.deepEqual(directory.discoverPeer({
    from: "api",
    to: "cache",
    now,
  }), {
    ok: false,
    code: "internal-discovery.identity-required",
    reason: "shop.cache has no SVID identity; public DNS fallback is forbidden",
  });
});

function fixtureDirectory() {
  const directory = createInternalServiceDirectory({
    camp: "prod-us",
    tenant: "tenant-acme",
    bindle: "shop",
    trustDomain: "yard",
  });

  directory.registerResource({
    name: "api",
    provider: "aws",
    region: "us-east-1",
    svid: "spiffe://yard/tenant-acme/shop/api",
    endpoint: createProviderEndpoint({
      host: "api.internal.aws",
      address: "10.0.0.10",
      port: 443,
    }),
  });

  directory.registerResource({
    name: "db",
    provider: "azure",
    region: "eastus",
    svid: "spiffe://yard/tenant-acme/shop/db",
    endpoint: createProviderEndpoint({
      host: "db.internal.azure",
      address: "10.2.0.8",
      port: 443,
    }),
    publicDnsRecords: ["db-public.example.com", "db-public-2.example.com"],
  });

  directory.bind({ from: "api", to: "db", verbs: ["connect"] });

  return directory;
}
