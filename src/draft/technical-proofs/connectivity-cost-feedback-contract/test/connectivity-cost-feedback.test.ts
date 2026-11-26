import assert from "node:assert/strict";
import { test } from "vitest";

import {
  annotateTopologyEdges,
  detectStaleTopologyAnnotation,
  estimateConnectivityFeedback
} from "../src/connectivity-cost-feedback.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

test("same-region and cross-cloud edges produce tier-keyed egress and latency topology annotations", () => {
  const sameRegionPlan = connectivityPlan({
    edgeId: "edge-api-cache",
    tier: ConnectivityTier.SAME_PROVIDER_REGION,
    source: { provider: "aws", region: "us-east-1", yardId: "yard-aws-east", resourceId: "shop-api" },
    target: { provider: "aws", region: "us-east-1", yardId: "yard-aws-east", resourceId: "shop-cache" }
  });
  const crossCloudPlan = connectivityPlan({
    edgeId: "edge-api-ledger",
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    source: { provider: "aws", region: "us-east-1", yardId: "yard-aws-east", resourceId: "shop-api" },
    target: { provider: "gcp", region: "us-central1", yardId: "yard-gcp-central", resourceId: "shop-ledger" }
  });
  const sameRegion = estimateConnectivityFeedback({
    plan: sameRegionPlan,
    costCatalog: egressCostCatalog(),
    latencyCatalog: latencyCatalog()
  });
  const crossCloud = estimateConnectivityFeedback({
    plan: crossCloudPlan,
    costCatalog: egressCostCatalog(),
    latencyCatalog: latencyCatalog()
  });

  assert.deepEqual(sameRegion, {
    ok: true,
    edgeId: "edge-api-cache",
    tier: ConnectivityTier.SAME_PROVIDER_REGION,
    tierLabel: "tier-1-same-provider-region",
    estimate: {
      egressPerGbUsd: 0,
      latencyMsP50: 2,
      rating: "rated",
      costKey: "tier:1:aws:us-east-1->aws:us-east-1",
      latencyKey: "tier:1:aws:us-east-1->aws:us-east-1"
    },
    plannerFeedback: {
      signal: "connectivity-cost-latency",
      edgeId: "edge-api-cache",
      tier: ConnectivityTier.SAME_PROVIDER_REGION,
      egressPerGbUsd: 0,
      latencyMsP50: 2,
      rating: "rated"
    },
    topologyAnnotation: {
      edgeId: "edge-api-cache",
      sourceResourceId: "shop-api",
      targetResourceId: "shop-cache",
      tier: ConnectivityTier.SAME_PROVIDER_REGION,
      tierLabel: "tier-1-same-provider-region",
      estimatedEgressPerGbUsd: 0,
      estimatedLatencyMsP50: 2,
      rating: "rated"
    }
  });
  assert.equal(crossCloud.ok, true);
  assert.equal(crossCloud.estimate.egressPerGbUsd, 0.09);
  assert.equal(crossCloud.estimate.latencyMsP50, 42);
  assert.ok(crossCloud.estimate.egressPerGbUsd > sameRegion.estimate.egressPerGbUsd);
  assert.ok(crossCloud.estimate.latencyMsP50 > sameRegion.estimate.latencyMsP50);

  assert.deepEqual(
    annotateTopologyEdges({
      plans: [sameRegionPlan, crossCloudPlan],
      costCatalog: egressCostCatalog(),
      latencyCatalog: latencyCatalog()
    }),
    {
      ok: true,
      annotations: [sameRegion.topologyAnnotation, crossCloud.topologyAnnotation],
      plannerFeedback: [sameRegion.plannerFeedback, crossCloud.plannerFeedback]
    }
  );
});

test("tier changes are detected when an existing topology annotation still carries the old estimate", () => {
  const oldPlan = connectivityPlan({
    edgeId: "edge-api-ledger",
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    source: { provider: "aws", region: "us-east-1", yardId: "yard-aws-east", resourceId: "shop-api" },
    target: { provider: "gcp", region: "us-central1", yardId: "yard-gcp-central", resourceId: "shop-ledger" }
  });
  const newPlan = connectivityPlan({
    edgeId: "edge-api-ledger",
    tier: ConnectivityTier.OVERLAY_MESH,
    source: { provider: "aws", region: "us-east-1", yardId: "yard-aws-east", resourceId: "shop-api" },
    target: { provider: "gcp", region: "us-central1", yardId: "yard-gcp-central", resourceId: "shop-ledger" }
  });
  const oldAnnotation = estimateConnectivityFeedback({
    plan: oldPlan,
    costCatalog: egressCostCatalog(),
    latencyCatalog: latencyCatalog()
  }).topologyAnnotation;

  assert.deepEqual(
    detectStaleTopologyAnnotation({
      currentPlan: newPlan,
      existingAnnotation: oldAnnotation,
      costCatalog: egressCostCatalog(),
      latencyCatalog: latencyCatalog()
    }),
    {
      ok: false,
      code: "connectivity-feedback.annotation.stale",
      reason: "edge edge-api-ledger annotation carries tier 3 / $0.09 / 42ms but current plan requires tier 4 / $0.12 / 65ms",
      expectedAnnotation: {
        edgeId: "edge-api-ledger",
        sourceResourceId: "shop-api",
        targetResourceId: "shop-ledger",
        tier: ConnectivityTier.OVERLAY_MESH,
        tierLabel: "tier-4-overlay-mesh",
        estimatedEgressPerGbUsd: 0.12,
        estimatedLatencyMsP50: 65,
        rating: "rated"
      }
    }
  );
});

test("missing egress cost data labels the edge unrated and never silently reports zero", () => {
  const plan = connectivityPlan({
    edgeId: "edge-api-ledger",
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    source: { provider: "aws", region: "us-east-1", yardId: "yard-aws-east", resourceId: "shop-api" },
    target: { provider: "gcp", region: "us-central1", yardId: "yard-gcp-central", resourceId: "shop-ledger" }
  });

  const feedback = estimateConnectivityFeedback({
    plan,
    costCatalog: {
      currency: "USD",
      egressPerGbByTier: {
        1: { default: 0 }
      }
    },
    latencyCatalog: latencyCatalog()
  });

  assert.equal(feedback.ok, true);
  assert.equal(feedback.estimate.rating, "unrated");
  assert.equal(feedback.estimate.egressPerGbUsd, null);
  assert.notEqual(feedback.topologyAnnotation.estimatedEgressPerGbUsd, 0);
  assert.deepEqual(feedback.topologyAnnotation, {
    edgeId: "edge-api-ledger",
    sourceResourceId: "shop-api",
    targetResourceId: "shop-ledger",
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    tierLabel: "tier-3-cross-provider-private-interconnect",
    estimatedEgressPerGbUsd: null,
    estimatedLatencyMsP50: 42,
    rating: "unrated",
    unratedReason: "missing cost catalog entry for tier 3"
  });
});

function connectivityPlan({ edgeId, tier, source, target }) {
  return {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId,
    source,
    target,
    tier,
    endpoints: {
      sourceLogicalName: `ctx.bindings.${source.resourceId}`,
      targetLogicalName: `ctx.bindings.${target.resourceId}`
    },
    identity: {
      source: `spiffe://tenant-a/shop/${source.resourceId}`,
      target: `spiffe://tenant-a/shop/${target.resourceId}`
    },
    parameters: {},
    policy: {
      maxTier: ConnectivityTier.PUBLIC_MTLS,
      allowPublicMtls: true
    }
  };
}

function egressCostCatalog() {
  return {
    currency: "USD",
    egressPerGbByTier: {
      1: { default: 0 },
      3: { default: 0.09 },
      4: { default: 0.12 }
    }
  };
}

function latencyCatalog() {
  return {
    latencyMsP50ByTier: {
      1: { default: 2 },
      3: { default: 42 },
      4: { default: 65 }
    }
  };
}
