import assert from "node:assert/strict";
import { test } from "vitest";

import {
  canReachTierTwoPeer,
  determineTierTwoFallback,
  realizeTierTwoCrossRegionLink,
  resolveTierTwoBinding
} from "../src/tier-two-cross-region-network.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

const NOW = "2026-06-28T18:00:00.000Z";

test("same-provider cross-region bind realizes private backbone peering with endpoint injection and mTLS", () => {
  const realization = realizeTierTwoCrossRegionLink({
    plan: tierTwoPlan(),
    providerBackboneCatalog: {
      aws: [
        {
          sourceRegion: "us-east-1",
          targetRegion: "us-west-2",
          backboneRef: "aws:global-backbone",
          peeringRef: "aws:pcx/east-west-001"
        }
      ]
    },
    providerOutputs: {
      "orders-db": {
        privateEndpoint: "10.44.2.17:5432"
      }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
    now: NOW,
    verbs: ["connect", "query"]
  });

  assert.equal(realization.ok, true);
  assert.equal(realization.link.tier, ConnectivityTier.SAME_PROVIDER_CROSS_REGION);
  assert.equal(realization.link.provider, "aws");
  assert.equal(realization.link.sourceRegion, "us-east-1");
  assert.equal(realization.link.targetRegion, "us-west-2");
  assert.equal(realization.link.route.publicExposure, false);
  assert.equal(realization.link.route.transport, "provider-backbone-private-peering");
  assert.equal(realization.link.route.backboneRef, "aws:global-backbone");
  assert.equal(realization.link.route.peeringRef, "aws:pcx/east-west-001");
  assert.deepEqual(realization.link.bindingInjection, {
    binding: "ctx.bindings.db",
    targetResourceId: "orders-db",
    endpoint: "10.44.2.17:5432",
    sourceResourceId: "orders-api",
    providerOutputKey: "privateEndpoint",
    sourceRegion: "us-east-1",
    targetRegion: "us-west-2"
  });
  assert.equal(realization.mtls.ok, true);
  assert.equal(realization.mtls.peer.resource, "orders-db");

  assert.deepEqual(
    canReachTierTwoPeer(realization.link, {
      fromResourceId: "orders-api",
      toResourceId: "orders-db",
      peerSvid: "spiffe://tenant-a/shop/orders-db"
    }),
    { ok: true }
  );
});

test("endpoint address changes re-resolve across regions without app edits", () => {
  const realization = realizeTierTwoCrossRegionLink({
    plan: tierTwoPlan(),
    providerBackboneCatalog: {
      aws: [
        {
          sourceRegion: "us-east-1",
          targetRegion: "us-west-2",
          backboneRef: "aws:global-backbone",
          peeringRef: "aws:pcx/east-west-001"
        }
      ]
    },
    providerOutputs: {
      "orders-db": { privateEndpoint: "10.44.2.17:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
    now: NOW
  });

  assert.equal(realization.ok, true);
  assert.deepEqual(
    resolveTierTwoBinding(realization.link, {
      "orders-db": { privateEndpoint: "10.55.8.12:5432" }
    }),
    {
      ok: true,
      binding: "ctx.bindings.db",
      targetResourceId: "orders-db",
      endpoint: "10.55.8.12:5432",
      sourceResourceId: "orders-api",
      providerOutputKey: "privateEndpoint",
      sourceRegion: "us-east-1",
      targetRegion: "us-west-2"
    }
  );
});

test("region pair with no private backbone peering falls through to overlay deterministically, never public first", () => {
  const decision = determineTierTwoFallback({
    plan: tierTwoPlan({
      target: { region: "ap-south-1" },
      residency: {
        tag: "global-private",
        allowedRegions: ["us-east-1", "ap-south-1"]
      }
    }),
    providerBackboneCatalog: {
      aws: [
        {
          sourceRegion: "us-east-1",
          targetRegion: "us-west-2",
          backboneRef: "aws:global-backbone",
          peeringRef: "aws:pcx/east-west-001"
        }
      ]
    },
    availableCapabilities: ["public-mtls", "overlay-mesh"]
  });

  assert.deepEqual(decision, {
    ok: true,
    nextTier: ConnectivityTier.OVERLAY_MESH,
    reason: "provider-backbone-private-peering unavailable for aws us-east-1<->ap-south-1",
    publicExposure: false,
    requiresExplicitPublicApproval: false
  });
});

test("public fallback is explicit and review-gated when no private fallback exists", () => {
  const decision = determineTierTwoFallback({
    plan: tierTwoPlan({
      target: { region: "ap-south-1" },
      residency: {
        tag: "global-private",
        allowedRegions: ["us-east-1", "ap-south-1"]
      }
    }),
    providerBackboneCatalog: { aws: [] },
    availableCapabilities: ["public-mtls"]
  });

  assert.deepEqual(decision, {
    ok: true,
    nextTier: ConnectivityTier.PUBLIC_MTLS,
    reason: "provider-backbone-private-peering unavailable for aws us-east-1<->ap-south-1",
    publicExposure: true,
    requiresExplicitPublicApproval: true
  });
});

test("residency-constrained edge is not peered across a forbidden region boundary", () => {
  const decision = realizeTierTwoCrossRegionLink({
    plan: tierTwoPlan({
      residency: {
        tag: "us-east-only",
        allowedRegions: ["us-east-1"]
      }
    }),
    providerBackboneCatalog: {
      aws: [
        {
          sourceRegion: "us-east-1",
          targetRegion: "us-west-2",
          backboneRef: "aws:global-backbone",
          peeringRef: "aws:pcx/east-west-001"
        }
      ]
    },
    providerOutputs: {
      "orders-db": { privateEndpoint: "10.44.2.17:5432" }
    },
    peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
    now: NOW
  });

  assert.deepEqual(decision, {
    ok: false,
    code: "tier2.residency.forbidden-region",
    reason: "residency tag us-east-only allows us-east-1 but edge crosses us-east-1->us-west-2"
  });
});

test("same-region and cross-provider plans fail closed instead of realizing adjacent tiers", () => {
  assert.deepEqual(
    realizeTierTwoCrossRegionLink({
      plan: tierTwoPlan({
        tier: ConnectivityTier.SAME_PROVIDER_REGION,
        target: { region: "us-east-1" }
      }),
      providerBackboneCatalog: { aws: [] },
      providerOutputs: {
        "orders-db": { privateEndpoint: "10.44.2.17:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier2.plan.unsupported-tier",
      reason: "tier 2 realization requires ConnectivityTier.SAME_PROVIDER_CROSS_REGION"
    }
  );

  assert.deepEqual(
    realizeTierTwoCrossRegionLink({
      plan: tierTwoPlan({
        target: { provider: "gcp", region: "us-central1" }
      }),
      providerBackboneCatalog: { aws: [] },
      providerOutputs: {
        "orders-db": { privateEndpoint: "10.44.2.17:5432" }
      },
      peerCertificate: peerCertificate("spiffe://tenant-a/shop/orders-db"),
      now: NOW
    }),
    {
      ok: false,
      code: "tier2.plan.provider-mismatch",
      reason: "tier 2 requires source and target in the same provider"
    }
  );
});

function tierTwoPlan(overrides = {}) {
  const source = {
    resourceId: "orders-api",
    provider: "aws",
    region: "us-east-1",
    yardId: "yard-aws-prod-east",
    ...overrides.source
  };
  const target = {
    resourceId: "orders-db",
    provider: "aws",
    region: "us-west-2",
    yardId: "yard-aws-prod-west",
    ...overrides.target
  };

  return {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: "edge-api-db-cross-region",
    source,
    target,
    tier: overrides.tier ?? ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
    endpoints: {
      sourceLogicalName: "ctx.bindings.api",
      targetLogicalName: "ctx.bindings.db"
    },
    identity: {
      source: "spiffe://tenant-a/shop/orders-api",
      target: "spiffe://tenant-a/shop/orders-db"
    },
    parameters: {
      backboneRef: "aws:global-backbone",
      peeringRef: "us-east-1<->us-west-2"
    },
    residency: overrides.residency ?? {
      tag: "us-only",
      allowedRegions: ["us-east-1", "us-west-2"]
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
    serialNumber: "cert-002",
    notBefore: "2026-06-28T00:00:00.000Z",
    notAfter: "2026-06-29T00:00:00.000Z",
    rotationEpoch: 1
  };
}
