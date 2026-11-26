import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canReachTierOnePeer,
  realizeTierOnePrivateLink,
  resolveTierOneBinding
} from "../src/tier-one-private-network.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

const NOW = "2026-06-28T17:30:00.000Z";

test("same-provider same-region bind realizes scoped native private link with endpoint injection and mTLS", () => {
  const realization = realizeTierOnePrivateLink({
    plan: tierOnePlan(),
    providerOutputs: {
      "orders-api": { privateEndpoint: "10.12.0.24:8443" },
      "orders-db": { privateEndpoint: "10.12.1.17:5432", nativeNetworkId: "aws:vpc/vpc-123" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
    now: NOW,
    verbs: ["connect", "query"]
  });

  assert.equal(realization.ok, true);
  assert.equal(realization.link.tier, ConnectivityTier.SAME_PROVIDER_REGION);
  assert.equal(realization.link.nativeNetworkRef, "aws:us-east-1:native-private");
  assert.deepEqual(realization.link.securityRules, [
    {
      id: "edge-api-db:egress",
      direction: "egress",
      fromResourceId: "orders-api",
      toResourceId: "orders-db",
      peerSvid: "spiffe://tenant-a/shop/orders-db",
      verbs: ["connect", "query"]
    },
    {
      id: "edge-api-db:ingress",
      direction: "ingress",
      fromResourceId: "orders-api",
      toResourceId: "orders-db",
      peerSvid: "spiffe://tenant-a/shop/orders-api",
      verbs: ["connect", "query"]
    }
  ]);
  assert.deepEqual(realization.link.bindingInjection, {
    binding: "ctx.bindings.db",
    targetResourceId: "orders-db",
    endpoint: "10.12.1.17:5432",
    sourceResourceId: "orders-api",
    providerOutputKey: "privateEndpoint"
  });
  assert.equal(realization.mtls.ok, true);
  assert.equal(realization.mtls.peer.resource, "orders-db");

  assert.deepEqual(
    canReachTierOnePeer(realization.link, {
      fromResourceId: "orders-api",
      toResourceId: "orders-db",
      peerSvid: "spiffe://tenant-a/shop/orders-db"
    }),
    { ok: true }
  );
});

test("an unbound peer in the same native network is denied", () => {
  const realization = realizeTierOnePrivateLink({
    plan: tierOnePlan(),
    providerOutputs: {
      "orders-db": { privateEndpoint: "10.12.1.17:5432", nativeNetworkId: "aws:vpc/vpc-123" },
      "reports-api": { privateEndpoint: "10.12.4.20:8443", nativeNetworkId: "aws:vpc/vpc-123" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
    now: NOW,
    verbs: ["connect"]
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    canReachTierOnePeer(realization.link, {
      fromResourceId: "reports-api",
      toResourceId: "orders-db",
      peerSvid: "spiffe://tenant-a/shop/orders-db"
    }),
    {
      ok: false,
      code: "tier1.peer.not-bound",
      reason: "reports-api is not the bind edge source for orders-db"
    }
  );
});

test("endpoint address changes re-resolve without app edits", () => {
  const realization = realizeTierOnePrivateLink({
    plan: tierOnePlan(),
    providerOutputs: {
      "orders-db": { privateEndpoint: "10.12.1.17:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    resolveTierOneBinding(realization.link, {
      "orders-db": { privateEndpoint: "10.12.99.10:5432" }
    }),
    {
      ok: true,
      binding: "ctx.bindings.db",
      targetResourceId: "orders-db",
      endpoint: "10.12.99.10:5432",
      sourceResourceId: "orders-api",
      providerOutputKey: "privateEndpoint"
    }
  );
});

test("non-tier-one and cross-region plans fail closed instead of realizing adjacent tiers", () => {
  const plan = tierOnePlan({
    tier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
    target: { region: "us-west-2" }
  });

  assert.deepEqual(
    realizeTierOnePrivateLink({
      plan,
      providerOutputs: {
        "orders-db": { privateEndpoint: "10.12.1.17:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier1.plan.unsupported-tier",
      reason: "tier 1 realization requires ConnectivityTier.SAME_PROVIDER_REGION"
    }
  );
});

function tierOnePlan(overrides = {}) {
  const source = {
    resourceId: "orders-api",
    provider: "aws",
    region: "us-east-1",
    yardId: "yard-aws-prod",
    ...overrides.source
  };
  const target = {
    resourceId: "orders-db",
    provider: "aws",
    region: "us-east-1",
    yardId: "yard-aws-prod",
    ...overrides.target
  };

  return {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: "edge-api-db",
    source,
    target,
    tier: overrides.tier ?? ConnectivityTier.SAME_PROVIDER_REGION,
    endpoints: {
      sourceLogicalName: "ctx.bindings.api",
      targetLogicalName: "ctx.bindings.db"
    },
    identity: {
      source: "spiffe://tenant-a/shop/orders-api",
      target: "spiffe://tenant-a/shop/orders-db"
    },
    parameters: {
      nativeNetworkRef: "aws:us-east-1:native-private",
      securityPolicyRef: "edge-api-db:least-privilege"
    },
    policy: {
      maxTier: ConnectivityTier.PUBLIC_MTLS,
      allowPublicMtls: true
    }
  };
}

function peerCertificate(spiffeId) {
  return {
    spiffeId,
    serialNumber: "cert-001",
    notBefore: "2026-06-28T00:00:00.000Z",
    notAfter: "2026-06-29T00:00:00.000Z",
    rotationEpoch: 1
  };
}
