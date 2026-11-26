import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  evaluateMtlsHandshake,
  parseWorkloadSpiffeId
} from "../../mtls-data-path-contract/src/mtls-data-path.js";
import { isJsonString, isJsonObject } from "./json.js";


export const TIER_ONE_PRIVATE_NETWORK_SCHEMA_VERSION = "hobo.tier-one-private-network/v1";
const DEFAULT_PROVIDER_OUTPUT_KEY = "privateEndpoint";

export function realizeTierOnePrivateLink(input) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    return invalid("tier1.input.invalid", "input must be an object");
  }

  const planValidation = validateConnectivityPlan(input.plan);
  if (!planValidation.ok) return planValidation;

  if (input.plan.tier !== ConnectivityTier.SAME_PROVIDER_REGION) {
    return invalid(
      "tier1.plan.unsupported-tier",
      "tier 1 realization requires ConnectivityTier.SAME_PROVIDER_REGION"
    );
  }

  if (input.plan.source.provider !== input.plan.target.provider) {
    return invalid("tier1.plan.provider-mismatch", "tier 1 requires source and target in the same provider");
  }

  if (input.plan.source.region !== input.plan.target.region) {
    return invalid("tier1.plan.region-mismatch", "tier 1 requires source and target in the same region");
  }

  const binding = resolveBindingFromOutputs(input.plan, input.providerOutputs);
  if (!binding.ok) return binding;

  const verbs = normalizeVerbs(input.verbs);
  if (!verbs.ok) return verbs;

  let sourceIdentity;
  try {
    sourceIdentity = parseWorkloadSpiffeId(input.plan.identity.source);
  } catch (error) {
    return invalid("tier1.identity.invalid", error.message);
  }

  const link = {
    schemaVersion: TIER_ONE_PRIVATE_NETWORK_SCHEMA_VERSION,
    edgeId: input.plan.edgeId,
    tier: ConnectivityTier.SAME_PROVIDER_REGION,
    provider: input.plan.source.provider,
    region: input.plan.source.region,
    nativeNetworkRef: input.plan.parameters.nativeNetworkRef,
    securityPolicyRef: input.plan.parameters.securityPolicyRef,
    source: { ...input.plan.source },
    target: { ...input.plan.target },
    sourceSvid: input.plan.identity.source,
    targetSvid: input.plan.identity.target,
    bindingInjection: binding.binding,
    securityRules: [
      {
        id: `${input.plan.edgeId}:egress`,
        direction: "egress",
        fromResourceId: input.plan.source.resourceId,
        toResourceId: input.plan.target.resourceId,
        peerSvid: input.plan.identity.target,
        verbs: verbs.value
      },
      {
        id: `${input.plan.edgeId}:ingress`,
        direction: "ingress",
        fromResourceId: input.plan.source.resourceId,
        toResourceId: input.plan.target.resourceId,
        peerSvid: input.plan.identity.source,
        verbs: verbs.value
      }
    ]
  };

  const mtlsContract = {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: `${input.plan.edgeId}:tier1-mtls`,
    tenant: sourceIdentity.tenant,
    trustDomain: sourceIdentity.trustDomain,
    sourceSvid: input.plan.identity.source,
    certMaterialRef: `identity://${sourceIdentity.tenant}/${sourceIdentity.bindle}/${sourceIdentity.resource}/tier1/${input.plan.edgeId}`,
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

export function resolveTierOneBinding(link, providerOutputs) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier1.link.invalid", "link must be an object");
  }
  const result = resolveBindingForResource({
    targetResourceId: link.target?.resourceId,
    sourceResourceId: link.source?.resourceId,
    binding: link.bindingInjection?.binding,
    providerOutputs
  });
  if (!result.ok) return result;
  return { ok: true, ...result.binding };
}

export function canReachTierOnePeer(link, attempt) {
  if (!link || !isJsonObject(link) || Array.isArray(link)) {
    return invalid("tier1.link.invalid", "link must be an object");
  }
  if (!attempt || !isJsonObject(attempt) || Array.isArray(attempt)) {
    return invalid("tier1.reachability.invalid", "attempt must be an object");
  }

  if (attempt.fromResourceId !== link.source?.resourceId || attempt.toResourceId !== link.target?.resourceId) {
    return invalid(
      "tier1.peer.not-bound",
      `${attempt.fromResourceId} is not the bind edge source for ${attempt.toResourceId}`
    );
  }

  if (attempt.peerSvid !== link.targetSvid) {
    return invalid(
      "tier1.peer.svid-not-bound",
      `${attempt.peerSvid} is not the bind-derived target SVID for ${link.target?.resourceId}`
    );
  }

  return { ok: true };
}

function resolveBindingFromOutputs(plan, providerOutputs) {
  return resolveBindingForResource({
    targetResourceId: plan.target.resourceId,
    sourceResourceId: plan.source.resourceId,
    binding: plan.endpoints.targetLogicalName,
    providerOutputs
  });
}

function resolveBindingForResource({ targetResourceId, sourceResourceId, binding, providerOutputs }) {
  if (!providerOutputs || !isJsonObject(providerOutputs) || Array.isArray(providerOutputs)) {
    return invalid("tier1.provider-outputs.invalid", "providerOutputs must be an object keyed by resource id");
  }

  const outputs = providerOutputs[targetResourceId];
  if (!outputs || !isJsonObject(outputs) || Array.isArray(outputs)) {
    return invalid("tier1.endpoint.missing", `provider outputs missing for ${targetResourceId}`);
  }

  const endpoint = outputs[DEFAULT_PROVIDER_OUTPUT_KEY];
  if (!isJsonString(endpoint) || endpoint.length === 0) {
    return invalid("tier1.endpoint.missing", `${targetResourceId}.${DEFAULT_PROVIDER_OUTPUT_KEY} must be a non-empty string`);
  }

  return {
    ok: true,
    binding: {
      binding,
      targetResourceId,
      endpoint,
      sourceResourceId,
      providerOutputKey: DEFAULT_PROVIDER_OUTPUT_KEY
    }
  };
}

function normalizeVerbs(verbs = ["connect"]) {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    return invalid("tier1.verbs.invalid", "verbs must be a non-empty array");
  }
  const seen = new Set();
  const normalized = [];
  for (const verb of verbs) {
    if (!isJsonString(verb) || verb.length === 0) {
      return invalid("tier1.verbs.invalid", "verbs entries must be non-empty strings");
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
