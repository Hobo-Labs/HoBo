import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";

import { runNetworkingConnectivityDnsRelaySimulation } from "../../services/networking-reference-architecture.js";

const pactRoot = new URL("../pacts/", import.meta.url);

const EXPECTED_BOUNDARIES = Object.freeze([
  "ConnectivityTierSelector",
  "ConnectivityPolicyGate",
  "IdentityMtlsDataPath",
  "YardTopologyManifest",
  "JunctionConnectivityPlanner",
  "DnsShadowPort",
  "DomainValidationGate",
  "CertificateAuthority",
  "GatewayTrafficRouter",
  "CostRoutingLedger",
  "HoBoRelayPrivateExecutor",
  "TenantRoutingClaims",
]);

test("networking reference simulation satisfies every declared Pact boundary", async () => {
  const result = await runNetworkingConnectivityDnsRelaySimulation();
  const pacts = await Promise.all([
    loadPact("connectivity-tier-selector.pact.json"),
    loadPact("connectivity-policy-gate.pact.json"),
    loadPact("identity-mtls-data-path.pact.json"),
    loadPact("yard-topology-manifest.pact.json"),
    loadPact("junction-connectivity-planner.pact.json"),
    loadPact("dns-shadow-port.pact.json"),
    loadPact("domain-validation-gate.pact.json"),
    loadPact("certificate-authority.pact.json"),
    loadPact("gateway-traffic-router.pact.json"),
    loadPact("cost-routing-ledger.pact.json"),
    loadPact("hobo-relay-private-executor.pact.json"),
    loadPact("tenant-routing-claims.pact.json"),
  ]);

  assert.deepEqual(result.contracts.covered.sort(), [...EXPECTED_BOUNDARIES].sort());
  assert.equal(result.contracts.missing.length, 0);
  assert.deepEqual(pacts.map((pact) => pact.provider.name).sort(), [...EXPECTED_BOUNDARIES].sort());
});

async function loadPact(name) {
  return JSON.parse(await readFile(new URL(path.posix.join("./", name), pactRoot), "utf8"));
}
