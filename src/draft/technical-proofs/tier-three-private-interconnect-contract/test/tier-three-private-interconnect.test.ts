import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canReachTierThreePeer,
  determineTierThreeFallback,
  evaluateTierThreeProvisionedState,
  realizeTierThreePrivateInterconnect,
  resolveTierThreeBinding
} from "../src/tier-three-private-interconnect.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

const NOW = "2026-06-28T18:30:00.000Z";

test("cross-provider bind realizes a private interconnect with endpoint injection and mTLS", () => {
  const realization = realizeTierThreePrivateInterconnect({
    plan: tierThreePlan(),
    providerInterconnectCatalog: interconnectCatalog(),
    providerOutputs: {
      "orders-api": { privateEndpoint: "172.16.0.14:8443" },
      "orders-ledger": { privateEndpoint: "10.80.4.12:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW,
    verbs: ["connect", "query"]
  });

  assert.equal(realization.ok, true);
  assert.equal(realization.link.tier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.equal(realization.link.route.transport, "cross-provider-private-interconnect");
  assert.equal(realization.link.route.publicExposure, false);
  assert.equal(realization.link.route.interconnectKind, "aws-privatelink-to-gcp-psc");
  assert.equal(realization.link.route.sourceAttachmentRef, "aws:vpce/vpce-127");
  assert.equal(realization.link.route.targetServiceRef, "gcp:psc/service-127");
  assert.deepEqual(realization.link.bindingInjection, {
    binding: "ctx.bindings.ledger",
    targetResourceId: "orders-ledger",
    endpoint: "10.80.4.12:5432",
    sourceResourceId: "orders-api",
    providerOutputKey: "privateEndpoint",
    sourceProvider: "aws",
    targetProvider: "gcp"
  });
  assert.equal(realization.mtls.ok, true);
  assert.equal(realization.mtls.peer.resource, "orders-ledger");

  assert.deepEqual(
    canReachTierThreePeer(realization.link, {
      fromResourceId: "orders-api",
      toResourceId: "orders-ledger",
      peerSvid: "spiffe://tenant-a/shop/orders-ledger"
    }),
    { ok: true }
  );
});

test("endpoint output changes re-resolve across providers without app edits", () => {
  const realization = realizeTierThreePrivateInterconnect({
    plan: tierThreePlan(),
    providerInterconnectCatalog: interconnectCatalog(),
    providerOutputs: {
      "orders-ledger": { privateEndpoint: "10.80.4.12:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    resolveTierThreeBinding(realization.link, {
      "orders-ledger": { privateEndpoint: "10.91.8.21:5432" }
    }),
    {
      ok: true,
      binding: "ctx.bindings.ledger",
      targetResourceId: "orders-ledger",
      endpoint: "10.91.8.21:5432",
      sourceResourceId: "orders-api",
      providerOutputKey: "privateEndpoint",
      sourceProvider: "aws",
      targetProvider: "gcp"
    }
  );
});

test("equivalence class without private interconnect support falls through to overlay, never public first", () => {
  const decision = determineTierThreeFallback({
    plan: tierThreePlan({
      parameters: { equivalenceClassId: "kv-cross-provider-no-native" }
    }),
    providerInterconnectCatalog: interconnectCatalog(),
    availableCapabilities: ["public-mtls", "overlay-mesh"]
  });

  assert.deepEqual(decision, {
    ok: true,
    nextTier: ConnectivityTier.OVERLAY_MESH,
    reason: "private interconnect unavailable for equivalence class kv-cross-provider-no-native between aws and gcp",
    publicExposure: false,
    requiresExplicitPublicApproval: false
  });
});

test("reversed provider-pair catalog entries do not attach the wrong Yard half", () => {
  const decision = determineTierThreeFallback({
    plan: tierThreePlan(),
    providerInterconnectCatalog: [
      {
        equivalenceClassId: "kv-cross-provider-private",
        sourceProvider: "gcp",
        targetProvider: "aws",
        interconnectKind: "gcp-psc-to-aws-privatelink",
        sourceAttachmentRef: "gcp:psc/service-reversed",
        targetServiceRef: "aws:vpce/vpce-reversed",
        supportsMtls: true
      }
    ],
    availableCapabilities: ["overlay-mesh"]
  });

  assert.deepEqual(decision, {
    ok: true,
    nextTier: ConnectivityTier.OVERLAY_MESH,
    reason: "private interconnect unavailable for equivalence class kv-cross-provider-private between aws and gcp",
    publicExposure: false,
    requiresExplicitPublicApproval: false
  });
});

test("public fallback is explicit when overlay is unavailable", () => {
  const decision = determineTierThreeFallback({
    plan: tierThreePlan({
      parameters: { equivalenceClassId: "kv-cross-provider-no-native" }
    }),
    providerInterconnectCatalog: interconnectCatalog(),
    availableCapabilities: ["public-mtls"]
  });

  assert.deepEqual(decision, {
    ok: true,
    nextTier: ConnectivityTier.PUBLIC_MTLS,
    reason: "private interconnect unavailable for equivalence class kv-cross-provider-no-native between aws and gcp",
    publicExposure: true,
    requiresExplicitPublicApproval: true
  });
});

test("half-provisioned private interconnect is detected and rolled back instead of left open", () => {
  const realization = realizeTierThreePrivateInterconnect({
    plan: tierThreePlan(),
    providerInterconnectCatalog: interconnectCatalog(),
    providerOutputs: {
      "orders-ledger": { privateEndpoint: "10.80.4.12:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    evaluateTierThreeProvisionedState(realization.link, {
      sourceAttachmentRef: "aws:vpce/vpce-127",
      targetServiceRef: null
    }),
    {
      ok: false,
      code: "tier3.interconnect.partial",
      reason: "private interconnect edge-api-ledger has only one provisioned half",
      remediation: {
        action: "rollback",
        removeRefs: ["aws:vpce/vpce-127"],
        keepClosed: true
      }
    }
  );
});

test("same-provider and non-tier-three plans fail closed instead of realizing adjacent tiers", () => {
  assert.deepEqual(
    realizeTierThreePrivateInterconnect({
      plan: tierThreePlan({
        tier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
        target: { provider: "aws", region: "us-west-2", yardId: "yard-aws-prod-west" }
      }),
      providerInterconnectCatalog: interconnectCatalog(),
      providerOutputs: {
        "orders-ledger": { privateEndpoint: "10.80.4.12:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier3.plan.unsupported-tier",
      reason: "tier 3 realization requires ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT"
    }
  );

  assert.deepEqual(
    realizeTierThreePrivateInterconnect({
      plan: tierThreePlan({
        target: { provider: "aws", region: "us-west-2", yardId: "yard-aws-prod-west" }
      }),
      providerInterconnectCatalog: interconnectCatalog(),
      providerOutputs: {
        "orders-ledger": { privateEndpoint: "10.80.4.12:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier3.plan.provider-match",
      reason: "tier 3 requires source and target in different providers"
    }
  );
});

function tierThreePlan(overrides = {}) {
  const source = {
    resourceId: "orders-api",
    provider: "aws",
    region: "us-east-1",
    yardId: "yard-aws-prod",
    ...overrides.source
  };
  const target = {
    resourceId: "orders-ledger",
    provider: "gcp",
    region: "us-central1",
    yardId: "yard-gcp-prod",
    ...overrides.target
  };

  return {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: "edge-api-ledger",
    source,
    target,
    tier: overrides.tier ?? ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    endpoints: {
      sourceLogicalName: "ctx.bindings.api",
      targetLogicalName: "ctx.bindings.ledger"
    },
    identity: {
      source: "spiffe://tenant-a/shop/orders-api",
      target: "spiffe://tenant-a/shop/orders-ledger"
    },
    parameters: {
      equivalenceClassId: "kv-cross-provider-private",
      ...overrides.parameters
    },
    residency: overrides.residency ?? {
      tag: "us-only",
      allowedProviders: ["aws", "gcp"],
      allowedRegions: ["us-east-1", "us-central1"]
    },
    policy: {
      maxTier: ConnectivityTier.PUBLIC_MTLS,
      allowPublicMtls: true
    }
  };
}

function interconnectCatalog() {
  return [
    {
      equivalenceClassId: "kv-cross-provider-private",
      sourceProvider: "aws",
      targetProvider: "gcp",
      interconnectKind: "aws-privatelink-to-gcp-psc",
      sourceAttachmentRef: "aws:vpce/vpce-127",
      targetServiceRef: "gcp:psc/service-127",
      privateDnsZoneRef: "dns:private/orders-ledger.internal",
      supportsMtls: true
    }
  ];
}

function peerCertificate(spiffeId) {
  return {
    spiffeId,
    serialNumber: "cert-003",
    notBefore: "2026-06-28T00:00:00.000Z",
    notAfter: "2026-06-29T00:00:00.000Z",
    rotationEpoch: 1
  };
}
