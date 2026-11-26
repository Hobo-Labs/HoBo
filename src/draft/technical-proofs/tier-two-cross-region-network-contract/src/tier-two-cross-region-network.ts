import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  evaluateMtlsHandshake,
  parseWorkloadSpiffeId
} from "../../mtls-data-path-contract/src/mtls-data-path.js";
import { isJsonString, isJsonObject } from "./json.js";


export const TIER_TWO_CROSS_REGION_NETWORK_SCHEMA_VERSION = "hobo.tier-two-cross-region-network/v1";

const DEFAULT_PROVIDER_OUTPUT_KEY = "privateEndpoint";
const OVERLAY_CAPABILITY = "overlay-mesh";
const PUBLIC_MTLS_CAPABILITY = "public-mtls";

export function realizeTierTwoCrossRegionLink(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("tier2.input.invalid", "input must be an object");
  }

  const planValidation = validateTierTwoPlan(input.plan);
  if (!planValidation.ok) return planValidation;

  const residency = validateResidencyBoundary(input.plan);
  if (!residency.ok) return residency;

  const peering = resolveBackbonePeering(input.providerBackboneCatalog, input.plan);
  if (!peering.ok) return peering;

  const binding = resolveBindingFromOutputs(input.plan, input.providerOutputs);
  if (!binding.ok) return binding;

  const verbs = normalizeVerbs(input.verbs);
  if (!verbs.ok) return verbs;

  let sourceIdentity;
  try {
    sourceIdentity = parseWorkloadSpiffeId(input.plan.identity.source);
  } catch (error) {
    return invalid("tier2.identity.invalid", error.message);
  }

  const link = {
    schemaVersion: TIER_TWO_CROSS_REGION_NETWORK_SCHEMA_VERSION,
    edgeId: input.plan.edgeId,
    tier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
    provider: input.plan.source.provider,
    sourceRegion: input.plan.source.region,
    targetRegion: input.plan.target.region,
    source: { ...input.plan.source },
    target: { ...input.plan.target },
    sourceSvid: input.plan.identity.source,
    targetSvid: input.plan.identity.target,
    bindingInjection: binding.binding,
    residency: input.plan.residency ? clone(input.plan.residency) : undefined,
    route: {
      transport: "provider-backbone-private-peering",
      publicExposure: false,
      backboneRef: peering.backboneRef,
      peeringRef: peering.peeringRef
    },
    securityRules: [
      {
        id: `${input.plan.edgeId}:cross-region-egress`,
        direction: "egress",
        fromResourceId: input.plan.source.resourceId,
        toResourceId: input.plan.target.resourceId,
        peerSvid: input.plan.identity.target,
        verbs: verbs.value,
        regionBoundary: `${input.plan.source.region}->${input.plan.target.region}`
      },
      {
        id: `${input.plan.edgeId}:cross-region-ingress`,
        direction: "ingress",
        fromResourceId: input.plan.source.resourceId,
        toResourceId: input.plan.target.resourceId,
        peerSvid: input.plan.identity.source,
        verbs: verbs.value,
        regionBoundary: `${input.plan.source.region}->${input.plan.target.region}`
      }
    ]
  };

  const mtlsContract = {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: `${input.plan.edgeId}:tier2-mtls`,
    tenant: sourceIdentity.tenant,
    trustDomain: sourceIdentity.trustDomain,
    sourceSvid: input.plan.identity.source,
    certMaterialRef: `identity://${sourceIdentity.tenant}/${sourceIdentity.bindle}/${sourceIdentity.resource}/tier2/${input.plan.edgeId}`,
    peerCertificate: input.peerCertificate,
    allowedPeers: [input.plan.identity.target],
    authz: {
      bindEdgeId: input.plan.edgeId,
      verbs: verbs.value
    },
    now: input.now,
    minimumPeerRotationEpoch: input.minimumPeerRotationEpoch
  };

  const mtls = evaluateMtlsHandshake(mtlsContract);
  if (!mtls.ok) {
    return {
      ok: false,
      code: mtls.code,
      reason: mtls.reason,
      link
    };
  }

  return {
    ok: true,
    link,
    mtls,
    contract: mtlsContract
  };
}

export function determineTierTwoFallback({ plan, providerBackboneCatalog, availableCapabilities = [] } = {}) {
  const planValidation = validateTierTwoPlan(plan);
  if (!planValidation.ok) return planValidation;

  const residency = validateResidencyBoundary(plan);
  if (!residency.ok) return residency;

  const peering = resolveBackbonePeering(providerBackboneCatalog, plan);
  if (peering.ok) {
    return {
      ok: true,
      nextTier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION,
      reason: "provider-backbone-private-peering available",
      publicExposure: false,
      requiresExplicitPublicApproval: false
    };
  }

  const reason = peering.reason;
  if (availableCapabilities.includes(OVERLAY_CAPABILITY)) {
    return {
      ok: true,
      nextTier: ConnectivityTier.OVERLAY_MESH,
      reason,
      publicExposure: false,
      requiresExplicitPublicApproval: false
    };
  }

  if (availableCapabilities.includes(PUBLIC_MTLS_CAPABILITY)) {
    if (plan.policy?.allowPublicMtls === false || plan.policy?.maxTier < ConnectivityTier.PUBLIC_MTLS) {
      return invalid("tier2.fallback.public-disallowed", "policy disallows public+mTLS fallback");
    }
    return {
      ok: true,
      nextTier: ConnectivityTier.PUBLIC_MTLS,
      reason,
      publicExposure: true,
      requiresExplicitPublicApproval: true
    };
  }

  return invalid("tier2.fallback.unavailable", `${reason}; no private fallback capability is available`);
}

export function resolveTierTwoBinding(link, providerOutputs) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier2.link.invalid", "link must be an object");
  }
  const result = resolveBindingForResource({
    targetResourceId: link.target?.resourceId,
    sourceResourceId: link.source?.resourceId,
    binding: link.bindingInjection?.binding,
    sourceRegion: link.sourceRegion,
    targetRegion: link.targetRegion,
    providerOutputs
  });
  if (!result.ok) return result;
  return { ok: true, ...result.binding };
}

export function canReachTierTwoPeer(link, attempt) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier2.link.invalid", "link must be an object");
  }
  if (!attempt || !isJsonObject(attempt) || Array.isArray(attempt)) {
    return invalid("tier2.reachability.invalid", "attempt must be an object");
  }

  if (attempt.fromResourceId !== link.source?.resourceId || attempt.toResourceId !== link.target?.resourceId) {
    return invalid(
      "tier2.peer.not-bound",
      `${attempt.fromResourceId} is not the bind edge source for ${attempt.toResourceId}`
    );
  }

  if (attempt.peerSvid !== link.targetSvid) {
    return invalid(
      "tier2.peer.svid-not-bound",
      `${attempt.peerSvid} is not the bind-derived target SVID for ${link.target?.resourceId}`
    );
  }

  if (link.route?.publicExposure !== false) {
    return invalid("tier2.route.not-private", "tier 2 reachability must stay on private provider backbone peering");
  }

  return { ok: true };
}

function validateTierTwoPlan(plan) {
  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) return validation;

  if (plan.tier !== ConnectivityTier.SAME_PROVIDER_CROSS_REGION) {
    return invalid(
      "tier2.plan.unsupported-tier",
      "tier 2 realization requires ConnectivityTier.SAME_PROVIDER_CROSS_REGION"
    );
  }

  if (plan.source.provider !== plan.target.provider) {
    return invalid("tier2.plan.provider-mismatch", "tier 2 requires source and target in the same provider");
  }

  if (plan.source.region === plan.target.region) {
    return invalid("tier2.plan.same-region", "tier 2 requires source and target in different regions");
  }

  return { ok: true };
}

function validateResidencyBoundary(plan) {
  const allowedRegions = plan.residency?.allowedRegions;
  if (allowedRegions === undefined) return { ok: true };
  if (!Array.isArray(allowedRegions) || allowedRegions.some((region) => !isJsonString(region) || region.length === 0)) {
    return invalid("tier2.residency.invalid", "residency.allowedRegions must contain non-empty region strings");
  }
  if (!allowedRegions.includes(plan.source.region) || !allowedRegions.includes(plan.target.region)) {
    return invalid(
      "tier2.residency.forbidden-region",
      `residency tag ${plan.residency.tag} allows ${allowedRegions.join(", ")} but edge crosses ${plan.source.region}->${plan.target.region}`
    );
  }
  return { ok: true };
}

function resolveBackbonePeering(providerBackboneCatalog, plan) {
  if (!providerBackboneCatalog || !isJsonObject(providerBackboneCatalog) || Array.isArray(providerBackboneCatalog)) {
    return invalid("tier2.backbone-catalog.invalid", "providerBackboneCatalog must be an object keyed by provider");
  }

  const entries = providerBackboneCatalog[plan.source.provider];
  if (!Array.isArray(entries)) {
    return unavailable(plan);
  }

  const peering = entries.find((entry) => (
    entry?.sourceRegion === plan.source.region && entry?.targetRegion === plan.target.region
  ) || (
    entry?.sourceRegion === plan.target.region && entry?.targetRegion === plan.source.region
  ));

  if (!peering) return unavailable(plan);
  if (!isJsonString(peering.backboneRef) || peering.backboneRef.length === 0) {
    return invalid("tier2.backbone-catalog.invalid", "peering.backboneRef must be a non-empty string");
  }
  if (!isJsonString(peering.peeringRef) || peering.peeringRef.length === 0) {
    return invalid("tier2.backbone-catalog.invalid", "peering.peeringRef must be a non-empty string");
  }

  return {
    ok: true,
    backboneRef: peering.backboneRef,
    peeringRef: peering.peeringRef
  };
}

function unavailable(plan) {
  return invalid(
    "tier2.peering.unavailable",
    `provider-backbone-private-peering unavailable for ${plan.source.provider} ${plan.source.region}<->${plan.target.region}`
  );
}

function resolveBindingFromOutputs(plan, providerOutputs) {
  return resolveBindingForResource({
    targetResourceId: plan.target.resourceId,
    sourceResourceId: plan.source.resourceId,
    binding: plan.endpoints.targetLogicalName,
    sourceRegion: plan.source.region,
    targetRegion: plan.target.region,
    providerOutputs
  });
}

function resolveBindingForResource({
  targetResourceId,
  sourceResourceId,
  binding,
  sourceRegion,
  targetRegion,
  providerOutputs
}) {
  if (!providerOutputs || !isJsonObject(providerOutputs) || Array.isArray(providerOutputs)) {
    return invalid("tier2.provider-outputs.invalid", "providerOutputs must be an object keyed by resource id");
  }

  const outputs = providerOutputs[targetResourceId];
  if (!outputs || !isJsonObject(outputs) || Array.isArray(outputs)) {
    return invalid("tier2.endpoint.missing", `provider outputs missing for ${targetResourceId}`);
  }

  const endpoint = outputs[DEFAULT_PROVIDER_OUTPUT_KEY];
  if (!isJsonString(endpoint) || endpoint.length === 0) {
    return invalid("tier2.endpoint.missing", `${targetResourceId}.${DEFAULT_PROVIDER_OUTPUT_KEY} must be a non-empty string`);
  }

  return {
    ok: true,
    binding: {
      binding,
      targetResourceId,
      endpoint,
      sourceResourceId,
      providerOutputKey: DEFAULT_PROVIDER_OUTPUT_KEY,
      sourceRegion,
      targetRegion
    }
  };
}

function normalizeVerbs(verbs = ["connect"]) {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    return invalid("tier2.verbs.invalid", "verbs must be a non-empty array");
  }
  const seen = new Set();
  const normalized = [];
  for (const verb of verbs) {
    if (!isJsonString(verb) || verb.length === 0) {
      return invalid("tier2.verbs.invalid", "verbs entries must be non-empty strings");
    }
    if (!seen.has(verb)) {
      seen.add(verb);
      normalized.push(verb);
    }
  }
  return { ok: true, value: normalized };
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
