import { isJsonString, isJsonObject } from "./json.js";
export const CONNECTIVITY_PLAN_SCHEMA_VERSION = "hobo.connectivity-plan/v1";

export const ConnectivityTier = Object.freeze({
  SAME_PROVIDER_REGION: 1,
  SAME_PROVIDER_CROSS_REGION: 2,
  CROSS_PROVIDER_PRIVATE_INTERCONNECT: 3,
  OVERLAY_MESH: 4,
  PUBLIC_MTLS: 5
});

const VALID_TIERS = new Set(Object.values(ConnectivityTier));
const PRIVATE_INTERCONNECT_CAPABILITY = "private-interconnect";
const OVERLAY_CAPABILITY = "overlay-mesh";
const PUBLIC_MTLS_CAPABILITY = "public-mtls";

export function validateConnectivityPlan(plan) {
  if (!plan || !isJsonObject(plan) || Array.isArray(plan)) {
    return invalid("connectivity.plan.invalid", "plan must be an object");
  }
  if (plan.schemaVersion !== CONNECTIVITY_PLAN_SCHEMA_VERSION) {
    return invalid("connectivity.schema.unsupported", `schemaVersion must be ${CONNECTIVITY_PLAN_SCHEMA_VERSION}`);
  }
  const tierValidation = validateTier(plan.tier);
  if (!tierValidation.ok) return tierValidation;

  for (const [field, value] of [
    ["edgeId", plan.edgeId],
    ["source.resourceId", plan.source?.resourceId],
    ["target.resourceId", plan.target?.resourceId],
    ["source.provider", plan.source?.provider],
    ["target.provider", plan.target?.provider],
    ["source.region", plan.source?.region],
    ["target.region", plan.target?.region],
    ["source.yardId", plan.source?.yardId],
    ["target.yardId", plan.target?.yardId],
    ["endpoints.sourceLogicalName", plan.endpoints?.sourceLogicalName],
    ["endpoints.targetLogicalName", plan.endpoints?.targetLogicalName],
    ["identity.source", plan.identity?.source],
    ["identity.target", plan.identity?.target]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("connectivity.plan.required-field", `${field} must be a non-empty string`);
    }
  }

  if (!plan.parameters || !isJsonObject(plan.parameters) || Array.isArray(plan.parameters)) {
    return invalid("connectivity.parameters.invalid", "parameters must be an object");
  }

  const override = rejectPolicyWideningOverride(plan);
  if (!override.ok) return override;

  return { ok: true };
}

export function roundTripConnectivityPlan(plan) {
  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) {
    throw new Error(`${validation.code}: ${validation.reason}`);
  }
  return JSON.parse(JSON.stringify(sortKeys(plan)));
}

export function decideConnectivityTier(edge) {
  const baseValidation = validateBindEdge(edge);
  if (!baseValidation.ok) return baseValidation;

  const tier = selectTier(edge);
  if (!tier) {
    return invalid(
      "connectivity.tier.unresolvable",
      `no connectivity tier resolved for edge ${edge.edgeId}`
    );
  }

  const plan = {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: edge.edgeId,
    source: { ...edge.source },
    target: { ...edge.target },
    tier,
    endpoints: { ...edge.endpoints },
    identity: { ...edge.identity },
    parameters: defaultParametersForTier(tier, edge),
    residency: edge.residency ? { ...edge.residency } : undefined,
    policy: edge.policy ? { ...edge.policy } : undefined
  };

  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) return validation;

  return {
    ok: true,
    plan: roundTripConnectivityPlan(plan)
  };
}

export function rejectPolicyWideningOverride(plan) {
  if (!plan?.policy) return { ok: true };

  const policyTierValidation = validateTier(plan.policy.maxTier);
  if (!policyTierValidation.ok) {
    return invalid("connectivity.policy.invalid", "policy.maxTier must be one of 1, 2, 3, 4, 5");
  }

  const requestedTier = plan.override?.requestedTier ?? plan.tier;

  if (requestedTier > plan.policy.maxTier) {
    return invalid(
      "connectivity.override.policy-widening",
      `override requested tier ${requestedTier} beyond policy max tier ${plan.policy.maxTier}`
    );
  }

  if (requestedTier === ConnectivityTier.PUBLIC_MTLS && plan.policy.allowPublicMtls === false) {
    return invalid(
      "connectivity.override.policy-widening",
      "override requested public+mTLS but policy disallows public mTLS"
    );
  }

  return { ok: true };
}

function selectTier(edge) {
  if (edge.source.provider === edge.target.provider && edge.source.region === edge.target.region) {
    return ConnectivityTier.SAME_PROVIDER_REGION;
  }
  if (edge.source.provider === edge.target.provider) {
    return ConnectivityTier.SAME_PROVIDER_CROSS_REGION;
  }
  if (hasCapability(edge, PRIVATE_INTERCONNECT_CAPABILITY)) {
    return ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT;
  }
  if (hasCapability(edge, OVERLAY_CAPABILITY)) {
    return ConnectivityTier.OVERLAY_MESH;
  }
  if (hasCapability(edge, PUBLIC_MTLS_CAPABILITY)) {
    return ConnectivityTier.PUBLIC_MTLS;
  }
  return null;
}

function defaultParametersForTier(tier, edge) {
  switch (tier) {
    case ConnectivityTier.SAME_PROVIDER_REGION:
      return {
        nativeNetworkRef: `${edge.source.provider}:${edge.source.region}:native-private`,
        securityPolicyRef: `${edge.edgeId}:least-privilege`
      };
    case ConnectivityTier.SAME_PROVIDER_CROSS_REGION:
      return {
        backboneRef: `${edge.source.provider}:backbone`,
        peeringRef: `${edge.source.region}<->${edge.target.region}`
      };
    case ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT:
      return {
        interconnectKind: "private-service",
        serviceRef: `${edge.source.provider}<->${edge.target.provider}`
      };
    case ConnectivityTier.OVERLAY_MESH:
      return {
        meshKind: "wireguard-ebpf",
        meshPolicyRef: `${edge.edgeId}:mesh-policy`
      };
    case ConnectivityTier.PUBLIC_MTLS:
      return {
        publicEndpointRef: edge.endpoints.targetLogicalName,
        mtlsRequired: true
      };
    default:
      throw new Error(`unsupported tier ${tier}`);
  }
}

function validateBindEdge(edge) {
  if (!edge || !isJsonObject(edge) || Array.isArray(edge)) {
    return invalid("connectivity.edge.invalid", "edge must be an object");
  }
  for (const [field, value] of [
    ["edgeId", edge.edgeId],
    ["source.resourceId", edge.source?.resourceId],
    ["target.resourceId", edge.target?.resourceId],
    ["source.provider", edge.source?.provider],
    ["target.provider", edge.target?.provider],
    ["source.region", edge.source?.region],
    ["target.region", edge.target?.region],
    ["source.yardId", edge.source?.yardId],
    ["target.yardId", edge.target?.yardId],
    ["endpoints.sourceLogicalName", edge.endpoints?.sourceLogicalName],
    ["endpoints.targetLogicalName", edge.endpoints?.targetLogicalName],
    ["identity.source", edge.identity?.source],
    ["identity.target", edge.identity?.target]
  ]) {
    if (!isNonEmptyString(value)) {
      return invalid("connectivity.edge.required-field", `${field} must be a non-empty string`);
    }
  }
  return { ok: true };
}

function validateTier(tier) {
  if (!VALID_TIERS.has(tier)) {
    return invalid("connectivity.tier.unsupported", "tier must be one of 1, 2, 3, 4, 5");
  }
  return { ok: true };
}

function hasCapability(edge, capability) {
  return Array.isArray(edge.availableCapabilities) && edge.availableCapabilities.includes(capability);
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.length > 0;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => {
    const child = value[key];
    return child === undefined ? [] : [key, sortKeys(child)];
  }).filter((entry) => entry.length === 2));
}
