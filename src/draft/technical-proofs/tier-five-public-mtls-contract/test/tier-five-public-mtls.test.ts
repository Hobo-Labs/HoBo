import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canReachTierFiveEndpoint,
  realizeTierFivePublicMtls
} from "../src/tier-five-public-mtls.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

const NOW = "2026-06-28T22:30:00.000Z";

test("public-tier edge exposes explicit public topology and accepts only the bound client SVID over mTLS", () => {
  const realization = realizeTierFivePublicMtls({
    plan: tierFivePlan(),
    clientCertificate: clientCertificate("spiffe://tenant-a/shop/orders-api"),
    now: NOW,
    verbs: ["connect", "query"],
    environment: "prod",
    policyDecision: policyDecision()
  });

  assert.equal(realization.ok, true);
  assert.equal(realization.link.tier, ConnectivityTier.PUBLIC_MTLS);
  assert.equal(realization.link.route.transport, "public-mtls");
  assert.equal(realization.link.route.publicExposure, true);
  assert.equal(realization.link.route.publicEndpointRef, "public://orders-ledger");
  assert.equal(realization.link.route.fallbackFromTier, ConnectivityTier.OVERLAY_MESH);
  assert.equal(
    realization.link.route.fallbackReason,
    "overlay mesh unavailable: target provider does not allow managed overlay nodes"
  );
  assert.deepEqual(realization.link.mtlsPolicy.allowedClientSvids, [
    "spiffe://tenant-a/shop/orders-api"
  ]);
  assert.deepEqual(realization.topology.edges, [
    {
      edgeId: "edge-api-ledger",
      tier: ConnectivityTier.PUBLIC_MTLS,
      public: true,
      publicExposure: true,
      mtlsRequired: true,
      sourceResourceId: "orders-api",
      targetResourceId: "orders-ledger",
      endpoint: "https://orders-ledger.public.example.com:443",
      authorizedClientSvids: ["spiffe://tenant-a/shop/orders-api"]
    }
  ]);
  assert.equal(realization.mtls.ok, true);
  assert.equal(realization.mtls.peer.resource, "orders-api");
});

test("valid but unauthorized client SVID is rejected before public endpoint reachability is granted", () => {
  const result = realizeTierFivePublicMtls({
    plan: tierFivePlan(),
    clientCertificate: clientCertificate("spiffe://tenant-a/shop/support-worker"),
    now: NOW,
    policyDecision: policyDecision()
  });

  assert.deepEqual(result, {
    ok: false,
    code: "mtls.peer.not-allowed",
    reason: "peer spiffe://tenant-a/shop/support-worker is not in the bind-derived allow-list",
    link: result.link
  });
  assert.equal(result.link.route.publicExposure, true);
  assert.deepEqual(
    canReachTierFiveEndpoint(result.link, {
      fromResourceId: "support-worker",
      toResourceId: "orders-ledger",
      protocol: "mtls",
      clientCertificate: clientCertificate("spiffe://tenant-a/shop/support-worker")
    }),
    {
      ok: false,
      code: "tier5.peer.not-bound",
      reason: "support-worker is not the bind edge source for public endpoint orders-ledger"
    }
  );
});

test("plain TLS downgrade with no client certificate is refused", () => {
  const realization = realizeTierFivePublicMtls({
    plan: tierFivePlan(),
    clientCertificate: clientCertificate("spiffe://tenant-a/shop/orders-api"),
    now: NOW,
    policyDecision: policyDecision()
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    canReachTierFiveEndpoint(realization.link, {
      fromResourceId: "orders-api",
      toResourceId: "orders-ledger",
      protocol: "tls"
    }),
    {
      ok: false,
      code: "tier5.mtls.required",
      reason: "tier 5 public endpoint requires mutual TLS with a client SVID certificate",
      failClosed: true
    }
  );
});

test("prod public-tier deny blocks deploy before exposing a public endpoint", () => {
  const result = realizeTierFivePublicMtls({
    plan: tierFivePlan(),
    clientCertificate: clientCertificate("spiffe://tenant-a/shop/orders-api"),
    now: NOW,
    environment: "prod",
    policyDecision: policyDecision({
      effect: "deny",
      reason: "mandatory-ceiling:no-public-tier",
      constraints: {
        maxTier: ConnectivityTier.OVERLAY_MESH,
        forbiddenTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.policy.denied");
  assert.equal(result.request.context.publicExposure, true);
  assert.equal(result.failClosed, true);
  assert.equal("link" in result, false);
  assert.equal("topology" in result, false);
});

test("tier five requires explicit tier-four fall-through evidence", () => {
  const result = realizeTierFivePublicMtls({
    plan: tierFivePlan({
      parameters: {
        fallbackFromTier: undefined,
        fallbackReason: undefined
      }
    }),
    clientCertificate: clientCertificate("spiffe://tenant-a/shop/orders-api"),
    now: NOW,
    policyDecision: policyDecision()
  });

  assert.deepEqual(result, {
    ok: false,
    code: "tier5.plan.invalid-fallback",
    reason: "tier 5 public mTLS realization requires an explicit tier 4 fall-through"
  });
});

test("source and target SVIDs must name the bound resources", () => {
  assert.deepEqual(
    realizeTierFivePublicMtls({
      plan: tierFivePlan({
        identity: {
          source: "spiffe://tenant-a/shop/support-worker"
        }
      }),
      clientCertificate: clientCertificate("spiffe://tenant-a/shop/support-worker"),
      now: NOW,
      policyDecision: policyDecision()
    }),
    {
      ok: false,
      code: "tier5.identity.source-mismatch",
      reason: "source SVID resource support-worker does not match plan source orders-api"
    }
  );

  assert.deepEqual(
    realizeTierFivePublicMtls({
      plan: tierFivePlan({
        identity: {
          target: "spiffe://tenant-a/shop/sibling-ledger"
        }
      }),
      clientCertificate: clientCertificate("spiffe://tenant-a/shop/orders-api"),
      now: NOW,
      policyDecision: policyDecision()
    }),
    {
      ok: false,
      code: "tier5.identity.target-mismatch",
      reason: "target SVID resource sibling-ledger does not match plan target orders-ledger"
    }
  );
});

function tierFivePlan(overrides = {}) {
  const source = {
    resourceId: "orders-api",
    provider: "aws",
    region: "us-east-1",
    yardId: "yard-aws-prod",
    ...overrides.source
  };
  const target = {
    resourceId: "orders-ledger",
    provider: "public-internet",
    region: "global",
    yardId: "yard-public",
    ...overrides.target
  };

  return {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: "edge-api-ledger",
    source,
    target,
    tier: overrides.tier ?? ConnectivityTier.PUBLIC_MTLS,
    endpoints: {
      sourceLogicalName: "ctx.bindings.api",
      targetLogicalName: "ctx.bindings.ledger"
    },
    identity: {
      source: "spiffe://tenant-a/shop/orders-api",
      target: "spiffe://tenant-a/shop/orders-ledger",
      ...overrides.identity
    },
    parameters: {
      publicEndpointRef: "public://orders-ledger",
      publicHost: "orders-ledger.public.example.com",
      publicPort: 443,
      mtlsRequired: true,
      fallbackFromTier: ConnectivityTier.OVERLAY_MESH,
      fallbackReason: "overlay mesh unavailable: target provider does not allow managed overlay nodes",
      ...overrides.parameters
    },
    policy: {
      maxTier: ConnectivityTier.PUBLIC_MTLS,
      allowPublicMtls: true
    }
  };
}

function clientCertificate(spiffeId) {
  return {
    spiffeId,
    serialNumber: "client-cert-005",
    notBefore: "2026-06-28T00:00:00.000Z",
    notAfter: "2026-06-29T00:00:00.000Z",
    rotationEpoch: 1
  };
}

function policyDecision(overrides = {}) {
  return {
    decisionId: "policy-decision-tier5",
    phase: "can-deploy",
    effect: "allow",
    reason: "public tier allowed by environment policy",
    evidence: { policyIds: ["pack-prod-network"] },
    obligations: [],
    constraints: {},
    ...overrides
  };
}
