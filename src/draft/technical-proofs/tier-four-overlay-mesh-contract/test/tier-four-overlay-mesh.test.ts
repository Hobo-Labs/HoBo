import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canReachTierFourPeer,
  evaluateOverlayNodeState,
  planOverlayNodeLifecycle,
  realizeTierFourOverlayMesh,
  resolveTierFourBinding
} from "../src/tier-four-overlay-mesh.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

const NOW = "2026-06-28T21:45:00.000Z";

test("cross-provider bind realizes an overlay mesh with scoped policy and mTLS", () => {
  const realization = realizeTierFourOverlayMesh({
    plan: tierFourPlan(),
    overlayNodeCatalog: overlayNodeCatalog(),
    providerOutputs: {
      "orders-api": { overlayEndpoint: "fd00:mesh::10:8443" },
      "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW,
    verbs: ["connect", "query"]
  });

  assert.equal(realization.ok, true);
  assert.equal(realization.link.tier, ConnectivityTier.OVERLAY_MESH);
  assert.equal(realization.link.route.transport, "wireguard-ebpf-overlay");
  assert.equal(realization.link.route.publicExposure, false);
  assert.equal(realization.link.route.meshKind, "wireguard-ebpf");
  assert.equal(realization.link.route.fallbackFromTier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.equal(
    realization.link.route.fallbackReason,
    "private interconnect unavailable for equivalence class kv-cross-provider-no-native"
  );
  assert.deepEqual(realization.link.overlayNodes.map((node) => node.nodeId), [
    "mesh-node-aws-use1",
    "mesh-node-gcp-usc1"
  ]);
  assert.deepEqual(realization.link.meshPolicy.allowedPeers, [
    {
      fromResourceId: "orders-api",
      toResourceId: "orders-ledger",
      peerSvid: "spiffe://tenant-a/shop/orders-ledger",
      verbs: ["connect", "query"]
    }
  ]);
  assert.deepEqual(realization.link.bindingInjection, {
    binding: "ctx.bindings.ledger",
    targetResourceId: "orders-ledger",
    endpoint: "fd00:mesh::20:5432",
    sourceResourceId: "orders-api",
    providerOutputKey: "overlayEndpoint",
    sourceProvider: "aws",
    targetProvider: "gcp"
  });
  assert.equal(realization.mtls.ok, true);
  assert.equal(realization.mtls.peer.resource, "orders-ledger");
});

test("only the bound peer can reach across the mesh even when another resource shares it", () => {
  const realization = realizeTierFourOverlayMesh({
    plan: tierFourPlan(),
    overlayNodeCatalog: overlayNodeCatalog(),
    providerOutputs: {
      "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    canReachTierFourPeer(realization.link, {
      fromResourceId: "orders-api",
      toResourceId: "orders-ledger",
      peerSvid: "spiffe://tenant-a/shop/orders-ledger"
    }),
    { ok: true }
  );
  assert.deepEqual(
    canReachTierFourPeer(realization.link, {
      fromResourceId: "support-worker",
      toResourceId: "orders-ledger",
      peerSvid: "spiffe://tenant-a/shop/orders-ledger"
    }),
    {
      ok: false,
      code: "tier4.peer.not-bound",
      reason: "support-worker is not the bind edge source for orders-ledger"
    }
  );
});

test("overlay endpoint output changes re-resolve without app edits", () => {
  const realization = realizeTierFourOverlayMesh({
    plan: tierFourPlan(),
    overlayNodeCatalog: overlayNodeCatalog(),
    providerOutputs: {
      "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    resolveTierFourBinding(realization.link, {
      "orders-ledger": { overlayEndpoint: "fd00:mesh::33:5432" }
    }),
    {
      ok: true,
      binding: "ctx.bindings.ledger",
      targetResourceId: "orders-ledger",
      endpoint: "fd00:mesh::33:5432",
      sourceResourceId: "orders-api",
      providerOutputKey: "overlayEndpoint",
      sourceProvider: "aws",
      targetProvider: "gcp"
    }
  );
});

test("overlay node losing its key fails closed", () => {
  const realization = realizeTierFourOverlayMesh({
    plan: tierFourPlan(),
    overlayNodeCatalog: overlayNodeCatalog(),
    providerOutputs: {
      "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    evaluateOverlayNodeState(realization.link, {
      nodes: [
        { nodeId: "mesh-node-aws-use1", keyStatus: "active", segmentId: "mesh-a" },
        { nodeId: "mesh-node-gcp-usc1", keyStatus: "lost", segmentId: "mesh-a" }
      ]
    }),
    {
      ok: false,
      code: "tier4.overlay.key-lost",
      reason: "overlay node mesh-node-gcp-usc1 lost its mesh key",
      failClosed: true
    }
  );
});

test("partitioned mesh segments do not silently route over public", () => {
  const realization = realizeTierFourOverlayMesh({
    plan: tierFourPlan(),
    overlayNodeCatalog: overlayNodeCatalog(),
    providerOutputs: {
      "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    evaluateOverlayNodeState(realization.link, {
      publicFallbackActive: true,
      nodes: [
        { nodeId: "mesh-node-aws-use1", keyStatus: "active", segmentId: "mesh-a" },
        { nodeId: "mesh-node-gcp-usc1", keyStatus: "active", segmentId: "mesh-b" }
      ]
    }),
    {
      ok: false,
      code: "tier4.overlay.public-fallback-forbidden",
      reason: "tier 4 overlay partition cannot silently route over public networking",
      failClosed: true
    }
  );
});

test("same-provider and non-tier-four plans fail closed instead of realizing adjacent tiers", () => {
  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT
      }),
      overlayNodeCatalog: overlayNodeCatalog(),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.plan.unsupported-tier",
      reason: "tier 4 realization requires ConnectivityTier.OVERLAY_MESH"
    }
  );

  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        target: { provider: "aws", region: "us-west-2", yardId: "yard-aws-prod-west" }
      }),
      overlayNodeCatalog: overlayNodeCatalog(),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.plan.provider-match",
      reason: "tier 4 requires source and target in different providers"
    }
  );
});

test("overlay realization requires explicit tier-three fall-through evidence", () => {
  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        parameters: {
          fallbackFromTier: undefined,
          fallbackReason: undefined
        }
      }),
      overlayNodeCatalog: overlayNodeCatalog(),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.plan.invalid-fallback",
      reason: "tier 4 overlay realization requires an explicit tier 3 fall-through"
    }
  );

  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        parameters: {
          fallbackFromTier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION
        }
      }),
      overlayNodeCatalog: overlayNodeCatalog(),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.plan.invalid-fallback",
      reason: "tier 4 overlay fallback must come from tier 3"
    }
  );
});

test("overlay mesh kind is pinned to wireguard-ebpf", () => {
  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        parameters: {
          meshKind: "generic-overlay"
        }
      }),
      overlayNodeCatalog: overlayNodeCatalog().map((node) => ({
        ...node,
        meshKind: "generic-overlay"
      })),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.plan.unsupported-mesh-kind",
      reason: "tier 4 overlay meshKind must be wireguard-ebpf"
    }
  );
});

test("source and target SVIDs must name the bound resources", () => {
  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        identity: {
          target: "spiffe://tenant-a/shop/sibling-ledger"
        }
      }),
      overlayNodeCatalog: overlayNodeCatalog(),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/sibling-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.identity.target-mismatch",
      reason: "target SVID resource sibling-ledger does not match plan target orders-ledger"
    }
  );

  assert.deepEqual(
    realizeTierFourOverlayMesh({
      plan: tierFourPlan({
        identity: {
          source: "spiffe://tenant-a/shop/sibling-api"
        }
      }),
      overlayNodeCatalog: overlayNodeCatalog(),
      providerOutputs: {
        "orders-ledger": { overlayEndpoint: "fd00:mesh::20:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-ledger"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier4.identity.source-mismatch",
      reason: "source SVID resource sibling-api does not match plan source orders-api"
    }
  );
});

test("overlay node lifecycle creates, rotates, drains, and retires without opening public fallback", () => {
  assert.deepEqual(
    planOverlayNodeLifecycle({
      nodeId: "mesh-node-aws-use1",
      current: { state: "missing" },
      desired: { state: "active", keyEpoch: 1 }
    }),
    {
      ok: true,
      action: "create",
      events: ["overlay.NodeCreated"],
      publicFallbackAllowed: false
    }
  );

  assert.deepEqual(
    planOverlayNodeLifecycle({
      nodeId: "mesh-node-aws-use1",
      current: { state: "active", keyEpoch: 1 },
      desired: { state: "active", keyEpoch: 2 }
    }),
    {
      ok: true,
      action: "rotate-key",
      events: ["overlay.NodeKeyRotated"],
      publicFallbackAllowed: false
    }
  );

  assert.deepEqual(
    planOverlayNodeLifecycle({
      nodeId: "mesh-node-aws-use1",
      current: { state: "active", keyEpoch: 2 },
      desired: { state: "retired", keyEpoch: 2 },
      activePeers: 3
    }),
    {
      ok: true,
      action: "drain",
      events: ["overlay.NodeDraining"],
      publicFallbackAllowed: false
    }
  );

  assert.deepEqual(
    planOverlayNodeLifecycle({
      nodeId: "mesh-node-aws-use1",
      current: { state: "draining", keyEpoch: 2 },
      desired: { state: "retired", keyEpoch: 2 },
      activePeers: 0
    }),
    {
      ok: true,
      action: "retire",
      events: ["overlay.NodeRetired"],
      publicFallbackAllowed: false
    }
  );
});

test("overlay lifecycle fails closed on key regression or public fallback", () => {
  assert.deepEqual(
    planOverlayNodeLifecycle({
      nodeId: "mesh-node-aws-use1",
      current: { state: "active", keyEpoch: 2 },
      desired: { state: "active", keyEpoch: 1 }
    }),
    {
      ok: false,
      code: "tier4.lifecycle.key-regression",
      reason: "overlay node mesh-node-aws-use1 cannot move from key epoch 2 to 1",
      failClosed: true
    }
  );

  assert.deepEqual(
    planOverlayNodeLifecycle({
      nodeId: "mesh-node-aws-use1",
      current: { state: "partitioned", keyEpoch: 2 },
      desired: { state: "active", keyEpoch: 2 },
      publicFallbackRequested: true
    }),
    {
      ok: false,
      code: "tier4.lifecycle.public-fallback-forbidden",
      reason: "overlay node mesh-node-aws-use1 cannot use public fallback during lifecycle repair",
      failClosed: true
    }
  );
});

function tierFourPlan(overrides = {}) {
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
    tier: overrides.tier ?? ConnectivityTier.OVERLAY_MESH,
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
      meshKind: "wireguard-ebpf",
      meshPolicyRef: "edge-api-ledger:mesh-policy",
      fallbackFromTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
      fallbackReason: "private interconnect unavailable for equivalence class kv-cross-provider-no-native",
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

function overlayNodeCatalog() {
  return [
    {
      nodeId: "mesh-node-aws-use1",
      provider: "aws",
      region: "us-east-1",
      yardId: "yard-aws-prod",
      meshKind: "wireguard-ebpf",
      publicFallbackAllowed: false
    },
    {
      nodeId: "mesh-node-gcp-usc1",
      provider: "gcp",
      region: "us-central1",
      yardId: "yard-gcp-prod",
      meshKind: "wireguard-ebpf",
      publicFallbackAllowed: false
    }
  ];
}

function peerCertificate(spiffeId) {
  return {
    spiffeId,
    serialNumber: "cert-004",
    notBefore: "2026-06-28T00:00:00.000Z",
    notAfter: "2026-06-29T00:00:00.000Z",
    rotationEpoch: 1
  };
}
