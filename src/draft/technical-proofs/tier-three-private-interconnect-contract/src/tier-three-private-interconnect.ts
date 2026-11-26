import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  evaluateMtlsHandshake,
  parseWorkloadSpiffeId
} from "../../mtls-data-path-contract/src/mtls-data-path.js";
import { isJsonString, isJsonObject } from "./json.js";


export const TIER_THREE_PRIVATE_INTERCONNECT_SCHEMA_VERSION = "hobo.tier-three-private-interconnect/v1";

const DEFAULT_PROVIDER_OUTPUT_KEY = "privateEndpoint";
const OVERLAY_CAPABILITY = "overlay-mesh";
const PUBLIC_MTLS_CAPABILITY = "public-mtls";

export function realizeTierThreePrivateInterconnect(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("tier3.input.invalid", "input must be an object");
  }

  const planValidation = validateTierThreePlan(input.plan);
  if (!planValidation.ok) return planValidation;

  const residency = validateResidencyBoundary(input.plan);
  if (!residency.ok) return residency;

  const interconnect = resolvePrivateInterconnect(input.providerInterconnectCatalog, input.plan);
  if (!interconnect.ok) return interconnect;

  const binding = resolveBindingFromOutputs(input.plan, input.providerOutputs);
  if (!binding.ok) return binding;

  const verbs = normalizeVerbs(input.verbs);
  if (!verbs.ok) return verbs;

  let sourceIdentity;
  try {
    sourceIdentity = parseWorkloadSpiffeId(input.plan.identity.source);
  } catch (error) {
    return invalid("tier3.identity.invalid", error.message);
  }

  const link = {
    schemaVersion: TIER_THREE_PRIVATE_INTERCONNECT_SCHEMA_VERSION,
    edgeId: input.plan.edgeId,
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    sourceProvider: input.plan.source.provider,
    targetProvider: input.plan.target.provider,
    source: { ...input.plan.source },
    target: { ...input.plan.target },
    sourceSvid: input.plan.identity.source,
    targetSvid: input.plan.identity.target,
    equivalenceClassId: input.plan.parameters.equivalenceClassId,
    bindingInjection: binding.binding,
    residency: input.plan.residency ? clone(input.plan.residency) : undefined,
    route: {
      transport: "cross-provider-private-interconnect",
      publicExposure: false,
      interconnectKind: interconnect.interconnectKind,
      sourceAttachmentRef: interconnect.sourceAttachmentRef,
      targetServiceRef: interconnect.targetServiceRef,
      privateDnsZoneRef: interconnect.privateDnsZoneRef
    },
    securityRules: [
      {
        id: `${input.plan.edgeId}:cross-provider-egress`,
        direction: "egress",
        fromResourceId: input.plan.source.resourceId,
        toResourceId: input.plan.target.resourceId,
        peerSvid: input.plan.identity.target,
        verbs: verbs.value,
        sourceProvider: input.plan.source.provider,
        targetProvider: input.plan.target.provider
      },
      {
        id: `${input.plan.edgeId}:cross-provider-ingress`,
        direction: "ingress",
        fromResourceId: input.plan.source.resourceId,
        toResourceId: input.plan.target.resourceId,
        peerSvid: input.plan.identity.source,
        verbs: verbs.value,
        sourceProvider: input.plan.source.provider,
        targetProvider: input.plan.target.provider
      }
    ]
  };

  const mtlsContract = {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: `${input.plan.edgeId}:tier3-mtls`,
    tenant: sourceIdentity.tenant,
    trustDomain: sourceIdentity.trustDomain,
    sourceSvid: input.plan.identity.source,
    certMaterialRef: `identity://${sourceIdentity.tenant}/${sourceIdentity.bindle}/${sourceIdentity.resource}/tier3/${input.plan.edgeId}`,
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

export function determineTierThreeFallback({ plan, providerInterconnectCatalog, availableCapabilities = [] } = {}) {
  const planValidation = validateTierThreePlan(plan);
  if (!planValidation.ok) return planValidation;

  const residency = validateResidencyBoundary(plan);
  if (!residency.ok) return residency;

  const interconnect = resolvePrivateInterconnect(providerInterconnectCatalog, plan);
  if (interconnect.ok) {
    return {
      ok: true,
      nextTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
      reason: "cross-provider private interconnect available",
      publicExposure: false,
      requiresExplicitPublicApproval: false
    };
  }

  const reason = interconnect.reason;
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
      return invalid("tier3.fallback.public-disallowed", "policy disallows public+mTLS fallback");
    }
    return {
      ok: true,
      nextTier: ConnectivityTier.PUBLIC_MTLS,
      reason,
      publicExposure: true,
      requiresExplicitPublicApproval: true
    };
  }

  return invalid("tier3.fallback.unavailable", `${reason}; no private fallback capability is available`);
}

export function resolveTierThreeBinding(link, providerOutputs) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier3.link.invalid", "link must be an object");
  }

  const result = resolveBindingForResource({
    targetResourceId: link.target?.resourceId,
    sourceResourceId: link.source?.resourceId,
    binding: link.bindingInjection?.binding,
    sourceProvider: link.sourceProvider,
    targetProvider: link.targetProvider,
    providerOutputs
  });
  if (!result.ok) return result;
  return { ok: true, ...result.binding };
}

export function canReachTierThreePeer(link, attempt) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier3.link.invalid", "link must be an object");
  }
  if (!attempt || !isJsonObject(attempt) || Array.isArray(attempt)) {
    return invalid("tier3.reachability.invalid", "attempt must be an object");
  }

  if (attempt.fromResourceId !== link.source?.resourceId || attempt.toResourceId !== link.target?.resourceId) {
    return invalid(
      "tier3.peer.not-bound",
      `${attempt.fromResourceId} is not the bind edge source for ${attempt.toResourceId}`
    );
  }

  if (attempt.peerSvid !== link.targetSvid) {
    return invalid(
      "tier3.peer.svid-not-bound",
      `${attempt.peerSvid} is not the bind-derived target SVID for ${link.target?.resourceId}`
    );
  }

  if (link.route?.publicExposure !== false) {
    return invalid("tier3.route.not-private", "tier 3 reachability must stay on a private interconnect");
  }

  if (!link.route?.sourceAttachmentRef || !link.route?.targetServiceRef) {
    return invalid("tier3.interconnect.partial", "tier 3 reachability requires both interconnect halves");
  }

  return { ok: true };
}

export function evaluateTierThreeProvisionedState(link, observedState) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier3.link.invalid", "link must be an object");
  }
  if (!observedState || !isJsonObject(observedState) || Array.isArray(observedState)) {
    return invalid("tier3.observed-state.invalid", "observedState must be an object");
  }

  const sourceProvisioned = observedState.sourceAttachmentRef === link.route?.sourceAttachmentRef;
  const targetProvisioned = observedState.targetServiceRef === link.route?.targetServiceRef;

  if (sourceProvisioned && targetProvisioned) {
    return { ok: true };
  }

  if (sourceProvisioned || targetProvisioned) {
    return {
      ok: false,
      code: "tier3.interconnect.partial",
      reason: `private interconnect ${link.edgeId} has only one provisioned half`,
      remediation: {
        action: "rollback",
        removeRefs: [sourceProvisioned ? link.route.sourceAttachmentRef : link.route.targetServiceRef],
        keepClosed: true
      }
    };
  }

  return invalid("tier3.interconnect.unprovisioned", `private interconnect ${link.edgeId} has no provisioned halves`);
}

function validateTierThreePlan(plan) {
  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) return validation;

  if (plan.tier !== ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT) {
    return invalid(
      "tier3.plan.unsupported-tier",
      "tier 3 realization requires ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT"
    );
  }

  if (plan.source.provider === plan.target.provider) {
    return invalid("tier3.plan.provider-match", "tier 3 requires source and target in different providers");
  }

  if (!isJsonString(plan.parameters.equivalenceClassId) || plan.parameters.equivalenceClassId.length === 0) {
    return invalid("tier3.plan.equivalence-class-missing", "parameters.equivalenceClassId must be a non-empty string");
  }

  return { ok: true };
}

function validateResidencyBoundary(plan) {
  const residency = plan.residency;
  if (residency === undefined) return { ok: true };

  if (residency.allowedProviders !== undefined) {
    if (!isStringArray(residency.allowedProviders)) {
      return invalid("tier3.residency.invalid", "residency.allowedProviders must contain non-empty provider strings");
    }
    if (!residency.allowedProviders.includes(plan.source.provider) || !residency.allowedProviders.includes(plan.target.provider)) {
      return invalid(
        "tier3.residency.forbidden-provider",
        `residency tag ${residency.tag} does not allow ${plan.source.provider}->${plan.target.provider}`
      );
    }
  }

  if (residency.allowedRegions !== undefined) {
    if (!isStringArray(residency.allowedRegions)) {
      return invalid("tier3.residency.invalid", "residency.allowedRegions must contain non-empty region strings");
    }
    if (!residency.allowedRegions.includes(plan.source.region) || !residency.allowedRegions.includes(plan.target.region)) {
      return invalid(
        "tier3.residency.forbidden-region",
        `residency tag ${residency.tag} allows ${residency.allowedRegions.join(", ")} but edge crosses ${plan.source.region}->${plan.target.region}`
      );
    }
  }

  return { ok: true };
}

function resolvePrivateInterconnect(providerInterconnectCatalog, plan) {
  if (!Array.isArray(providerInterconnectCatalog)) {
    return invalid("tier3.interconnect-catalog.invalid", "providerInterconnectCatalog must be an array");
  }

  const entry = providerInterconnectCatalog.find((candidate) => {
    if (candidate?.equivalenceClassId !== plan.parameters.equivalenceClassId) return false;
    return matchesProviderPair(candidate, plan);
  });

  if (!entry) {
    return unavailable(plan);
  }

  for (const field of ["interconnectKind", "sourceAttachmentRef", "targetServiceRef"]) {
    if (!isJsonString(entry[field]) || entry[field].length === 0) {
      return invalid("tier3.interconnect-catalog.invalid", `interconnect.${field} must be a non-empty string`);
    }
  }

  if (entry.supportsMtls !== true) {
    return invalid("tier3.interconnect.mtls-unsupported", "tier 3 private interconnect must preserve mTLS");
  }

  return {
    ok: true,
    interconnectKind: entry.interconnectKind,
    sourceAttachmentRef: entry.sourceAttachmentRef,
    targetServiceRef: entry.targetServiceRef,
    privateDnsZoneRef: entry.privateDnsZoneRef
  };
}

function matchesProviderPair(entry, plan) {
  return (
    entry.sourceProvider === plan.source.provider &&
    entry.targetProvider === plan.target.provider
  );
}

function unavailable(plan) {
  return invalid(
    "tier3.interconnect.unavailable",
    `private interconnect unavailable for equivalence class ${plan.parameters.equivalenceClassId} between ${plan.source.provider} and ${plan.target.provider}`
  );
}

function resolveBindingFromOutputs(plan, providerOutputs) {
  return resolveBindingForResource({
    targetResourceId: plan.target.resourceId,
    sourceResourceId: plan.source.resourceId,
    binding: plan.endpoints.targetLogicalName,
    sourceProvider: plan.source.provider,
    targetProvider: plan.target.provider,
    providerOutputs
  });
}

function resolveBindingForResource({
  targetResourceId,
  sourceResourceId,
  binding,
  sourceProvider,
  targetProvider,
  providerOutputs
}) {
  if (!providerOutputs || !isJsonObject(providerOutputs) || Array.isArray(providerOutputs)) {
    return invalid("tier3.provider-outputs.invalid", "providerOutputs must be an object keyed by resource id");
  }

  const outputs = providerOutputs[targetResourceId];
  if (!outputs || !isJsonObject(outputs) || Array.isArray(outputs)) {
    return invalid("tier3.endpoint.missing", `provider outputs missing for ${targetResourceId}`);
  }

  const endpoint = outputs[DEFAULT_PROVIDER_OUTPUT_KEY];
  if (!isJsonString(endpoint) || endpoint.length === 0) {
    return invalid("tier3.endpoint.missing", `${targetResourceId}.${DEFAULT_PROVIDER_OUTPUT_KEY} must be a non-empty string`);
  }

  return {
    ok: true,
    binding: {
      binding,
      targetResourceId,
      endpoint,
      sourceResourceId,
      providerOutputKey: DEFAULT_PROVIDER_OUTPUT_KEY,
      sourceProvider,
      targetProvider
    }
  };
}

function normalizeVerbs(verbs = ["connect"]) {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    return invalid("tier3.verbs.invalid", "verbs must be a non-empty array");
  }
  const seen = new Set();
  const normalized = [];
  for (const verb of verbs) {
    if (!isJsonString(verb) || verb.length === 0) {
      return invalid("tier3.verbs.invalid", "verbs entries must be non-empty strings");
    }
    if (!seen.has(verb)) {
      seen.add(verb);
      normalized.push(verb);
    }
  }
  return { ok: true, value: normalized };
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => isJsonString(entry) && entry.length > 0);
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
