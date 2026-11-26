import assert from "node:assert/strict";
import { test } from "vitest";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  bindle,
  camp,
  junction,
  providerSelection,
  yard
} from "../../topology-objects-contract/src/topology-objects.js";
import {
  invokeCrossCloudService,
  planCrossCloudJunction
} from "../src/cross-cloud-junction-mtls.js";

const localRuntime = Object.freeze({ kind: "runtime", id: "runtime-local" });
const awsProvider = providerSelection("aws", "default");
const azureProvider = providerSelection("azure", "default");

function resource(kind: string, name: string, portRef: string[] = [`hobo:${kind}`]) {
  return Object.freeze({
    kind,
    name,
    stableId: `${kind}:${name}`,
    portRef,
    toDescriptor() {
      return { kind, name, stableId: `${kind}:${name}`, portRef };
    }
  });
}

function buildMultiCloudTopology() {
  const orders = bindle("orders", (b) => {
    const api = b.use(resource("service", "api", ["wasi:http"]));
    const db = b.use(resource("data", "db"));
    return { api, db };
  });

  const awsCamp = camp("prod", {
    bindle: orders,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: awsProvider
  });
  const azureCamp = camp("prod", {
    bindle: orders,
    envType: "production",
    runtime: localRuntime,
    defaultProvider: azureProvider
  });

  const awsYard = yard("aws-us", { camps: [awsCamp] });
  const azureYard = yard("azure-eu", { camps: [azureCamp] });
  const fleet = junction("orders-prod", { yards: [awsYard, azureYard] });

  return { fleet, awsYard, azureYard };
}

function crossCloudFixture() {
  const { fleet } = buildMultiCloudTopology();

  return {
    junction: fleet,
    environment: "prod",
    policyDecision: allowPolicy({
      maxTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT
    }),
    bindEdges: [
      {
        edgeId: "orders.api->orders.db",
        source: {
          resourceId: "orders.api",
          provider: "aws",
          region: "us-east-1",
          yardId: "yard-aws-us"
        },
        target: {
          resourceId: "orders.db",
          provider: "azure",
          region: "eastus",
          yardId: "yard-azure-eu"
        },
        endpoints: {
          sourceLogicalName: "orders.api",
          targetLogicalName: "orders.db"
        },
        identity: {
          source: "spiffe://tenant-alpha/orders/api",
          target: "spiffe://tenant-alpha/orders/db"
        },
        availableCapabilities: ["private-interconnect", "overlay-mesh", "public-mtls"],
        residency: { tag: "us-only" },
        policy: { maxTier: 3, allowPublicMtls: false }
      }
    ],
    yardTopologies: [awsYardTopology(), azureYardTopology()],
    mtlsHandshake: {
      schemaVersion: "hobo.mtls-data-path/v1",
      connectionId: "orders-api-to-db",
      tenant: "tenant-alpha",
      trustDomain: "tenant-alpha",
      sourceSvid: "spiffe://tenant-alpha/orders/api",
      peerCertificate: {
        spiffeId: "spiffe://tenant-alpha/orders/db",
        serialNumber: "cert-db-001",
        notBefore: "2026-06-29T02:55:00.000Z",
        notAfter: "2026-06-29T04:55:00.000Z",
        rotationEpoch: 3
      },
      allowedPeers: ["spiffe://tenant-alpha/orders/db"],
      certMaterialRef: "identity://svid-cert/tenant-alpha/orders/api",
      minimumPeerRotationEpoch: 1,
      authz: {
        bindEdgeId: "orders.api->orders.db",
        verbs: ["connect", "query"]
      },
      now: "2026-06-29T03:00:00.000Z"
    }
  };
}

test("BDD: AWS-hosted service calls Azure-hosted service over SVID-keyed mTLS", () => {
  const fixture = crossCloudFixture();
  const plan = planCrossCloudJunction(fixture);
  assert.equal(plan.ok, true);
  assert.equal(plan.outcome, "deployable");
  assert.equal(plan.edgePlans[0].tier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.deepEqual(plan.junctionConnectivity.sharedStateWrites, []);
  assert.deepEqual([...plan.junctionConnectivity.deliveryYards].sort(), ["yard-aws-us", "yard-azure-eu"]);

  const annotation = plan.annotatedEdges[0];
  assert.equal(annotation.tier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.equal(annotation.estimatedEgressPerGbUsd, 0.02);
  assert.equal(annotation.estimatedLatencyMsP50, 18);

  const call = invokeCrossCloudService({
    planResult: plan,
    mtlsHandshake: fixture.mtlsHandshake
  });
  assert.equal(call.ok, true);
  assert.equal(call.transport, "mtls");
  assert.equal(call.source.provider, "aws");
  assert.equal(call.target.provider, "azure");
  assert.equal(call.source.svid.resource, "api");
  assert.equal(call.target.svid.resource, "db");
});

test("BDD: policy-ceiling violation is refused before cross-cloud invoke", () => {
  const fixture = crossCloudFixture();
  fixture.policyDecision = allowPolicy({
    maxTier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION
  });

  const plan = planCrossCloudJunction(fixture);
  assert.equal(plan.ok, false);
  assert.equal(plan.code, "connectivity.policy.inconsistent-allow");
  assert.match(plan.reason, /exceeds mandatory max tier/);

  const blockedInvoke = invokeCrossCloudService({
    planResult: plan,
    mtlsHandshake: fixture.mtlsHandshake
  });
  assert.equal(blockedInvoke.ok, false);
  assert.equal(blockedInvoke.code, "cross-cloud.plan.not-deployable");
});

test("junction() federates peer Yards without shared mutable state", () => {
  const { fleet } = buildMultiCloudTopology();
  assert.equal(fleet.kind, "junction");
  assert.deepEqual([...fleet.providerIds].sort(), ["aws", "azure"]);
  assert.equal(fleet.yards.length, 2);
});

function allowPolicy({ maxTier }: { maxTier: number }) {
  return {
    phase: "can-deploy",
    effect: "allow",
    decisionId: "policy-cross-cloud-001",
    constraints: {
      maxTier,
      requireMtls: true
    },
    evidence: {
      policyIds: ["connectivity-tier-ceiling"]
    }
  };
}

function awsYardTopology() {
  return {
    yard: {
      id: "yard-aws-us",
      provider: "aws",
      regions: ["us-east-1"],
      junctionId: "orders-prod"
    },
    providerZones: [{ id: "zone-aws", domain: "orders.internal", regions: ["us-east-1"] }],
    exposedEndpoints: [
      {
        resourceId: "orders.api",
        logicalName: "orders.api",
        campId: "prod-aws",
        provider: "aws",
        region: "us-east-1",
        dnsName: "orders-api.aws.internal",
        residencyTag: "us-only"
      }
    ],
    crossYardLinks: [
      {
        id: "orders.api->orders.db",
        bindleId: "orders",
        source: {
          yardId: "yard-aws-us",
          resourceId: "orders.api",
          endpoint: "orders.api",
          residencyTag: "us-only"
        },
        target: {
          yardId: "yard-azure-eu",
          resourceId: "orders.db",
          endpoint: "orders.db",
          residencyTag: "us-only"
        },
        requiredTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
        dnsRules: [
          {
            recordName: "orders-db.internal.orders.com",
            type: "CNAME",
            targets: ["orders-db.azure.internal"]
          }
        ]
      }
    ]
  };
}

function azureYardTopology() {
  return {
    yard: {
      id: "yard-azure-eu",
      provider: "azure",
      regions: ["eastus"],
      junctionId: "orders-prod"
    },
    providerZones: [{ id: "zone-azure", domain: "orders.internal", regions: ["eastus"] }],
    exposedEndpoints: [
      {
        resourceId: "orders.db",
        logicalName: "orders.db",
        campId: "prod-azure",
        provider: "azure",
        region: "eastus",
        dnsName: "orders-db.azure.internal",
        residencyTag: "us-only"
      }
    ]
  };
}
