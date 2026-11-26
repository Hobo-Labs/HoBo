import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { isJsonObject } from "./json.js";


const TIER_LABELS = Object.freeze({
  [ConnectivityTier.SAME_PROVIDER_REGION]: "tier-1-same-provider-region",
  [ConnectivityTier.SAME_PROVIDER_CROSS_REGION]: "tier-2-same-provider-cross-region",
  [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]: "tier-3-cross-provider-private-interconnect",
  [ConnectivityTier.OVERLAY_MESH]: "tier-4-overlay-mesh",
  [ConnectivityTier.PUBLIC_MTLS]: "tier-5-public-mtls"
});

export function estimateConnectivityFeedback({ plan, costCatalog, latencyCatalog } = {}) {
  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) return validation;

  const cost = lookupTierValue({
    table: costCatalog?.egressPerGbByTier,
    tier: plan.tier,
    plan,
    field: "egressPerGbUsd",
    allowMissing: true,
    missingReason: `missing cost catalog entry for tier ${plan.tier}`
  });
  if (!cost.ok) return cost;

  const latency = lookupTierValue({
    table: latencyCatalog?.latencyMsP50ByTier,
    tier: plan.tier,
    plan,
    field: "latencyMsP50"
  });
  if (!latency.ok) return latency;

  const estimate = {
    egressPerGbUsd: cost.value,
    latencyMsP50: latency.value,
    rating: cost.missing ? "unrated" : "rated",
    costKey: cost.key,
    latencyKey: latency.key
  };
  if (cost.missing) {
    estimate.unratedReason = cost.reason;
  }

  return {
    ok: true,
    edgeId: plan.edgeId,
    tier: plan.tier,
    tierLabel: TIER_LABELS[plan.tier],
    estimate,
    plannerFeedback: {
      signal: "connectivity-cost-latency",
      edgeId: plan.edgeId,
      tier: plan.tier,
      egressPerGbUsd: estimate.egressPerGbUsd,
      latencyMsP50: estimate.latencyMsP50,
      rating: estimate.rating,
      ...(estimate.unratedReason ? { unratedReason: estimate.unratedReason } : undefined)
    },
    topologyAnnotation: {
      edgeId: plan.edgeId,
      sourceResourceId: plan.source.resourceId,
      targetResourceId: plan.target.resourceId,
      tier: plan.tier,
      tierLabel: TIER_LABELS[plan.tier],
      estimatedEgressPerGbUsd: estimate.egressPerGbUsd,
      estimatedLatencyMsP50: estimate.latencyMsP50,
      rating: estimate.rating,
      ...(estimate.unratedReason ? { unratedReason: estimate.unratedReason } : undefined)
    }
  };
}

export function annotateTopologyEdges({ plans, costCatalog, latencyCatalog } = {}) {
  if (!Array.isArray(plans)) {
    return invalid("connectivity-feedback.plans.invalid", "plans must be an array");
  }

  const estimates = [];
  for (const plan of plans) {
    const estimate = estimateConnectivityFeedback({ plan, costCatalog, latencyCatalog });
    if (!estimate.ok) return estimate;
    estimates.push(estimate);
  }

  return {
    ok: true,
    annotations: estimates.map((estimate) => estimate.topologyAnnotation),
    plannerFeedback: estimates.map((estimate) => estimate.plannerFeedback)
  };
}

export function detectStaleTopologyAnnotation({
  currentPlan,
  existingAnnotation,
  costCatalog,
  latencyCatalog
} = {}) {
  const current = estimateConnectivityFeedback({ plan: currentPlan, costCatalog, latencyCatalog });
  if (!current.ok) return current;
  if (!existingAnnotation || !isJsonObject(existingAnnotation) || Array.isArray(existingAnnotation)) {
    return invalid("connectivity-feedback.annotation.invalid", "existingAnnotation must be an object");
  }

  const expected = current.topologyAnnotation;
  if (annotationsEqual(existingAnnotation, expected)) {
    return { ok: true, annotation: expected };
  }

  return {
    ok: false,
    code: "connectivity-feedback.annotation.stale",
    reason: `edge ${expected.edgeId} annotation carries tier ${existingAnnotation.tier} / $${existingAnnotation.estimatedEgressPerGbUsd} / ${existingAnnotation.estimatedLatencyMsP50}ms but current plan requires tier ${expected.tier} / $${expected.estimatedEgressPerGbUsd} / ${expected.estimatedLatencyMsP50}ms`,
    expectedAnnotation: expected
  };
}

function lookupTierValue({ table, tier, plan, field, allowMissing = false, missingReason }) {
  const key = `tier:${tier}:${plan.source.provider}:${plan.source.region}->${plan.target.provider}:${plan.target.region}`;
  if (table === undefined || table === null) {
    if (allowMissing) {
      return { ok: true, key, value: null, missing: true, reason: missingReason ?? "missing tier catalog" };
    }
    return invalid("connectivity-feedback.catalog.invalid", "tier catalog must be an object");
  }
  if (!isJsonObject(table) || Array.isArray(table)) {
    return invalid("connectivity-feedback.catalog.invalid", "tier catalog must be an object");
  }
  const tierEntry = table[tier];
  if (!tierEntry || !isJsonObject(tierEntry) || Array.isArray(tierEntry)) {
    if (allowMissing) {
      return { ok: true, key, value: null, missing: true, reason: missingReason ?? `missing catalog entry for tier ${tier}` };
    }
    return invalid("connectivity-feedback.catalog.missing-tier", `missing catalog entry for tier ${tier}`);
  }

  const value = tierEntry[key] ?? tierEntry.default;
  if (value === undefined && allowMissing) {
    return { ok: true, key, value: null, missing: true, reason: missingReason ?? `missing catalog value for ${key}` };
  }
  if (!Number.isFinite(value) || value < 0) {
    return invalid("connectivity-feedback.catalog.invalid-value", `${field} for ${key} must be a non-negative number`);
  }
  return { ok: true, key, value };
}

function annotationsEqual(left, right) {
  return (
    left.edgeId === right.edgeId &&
    left.sourceResourceId === right.sourceResourceId &&
    left.targetResourceId === right.targetResourceId &&
    left.tier === right.tier &&
    left.tierLabel === right.tierLabel &&
    left.estimatedEgressPerGbUsd === right.estimatedEgressPerGbUsd &&
    left.estimatedLatencyMsP50 === right.estimatedLatencyMsP50 &&
    left.rating === right.rating &&
    left.unratedReason === right.unratedReason
  );
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}
