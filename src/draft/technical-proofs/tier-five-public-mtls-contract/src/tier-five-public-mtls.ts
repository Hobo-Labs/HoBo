import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  evaluateMtlsHandshake,
  parseWorkloadSpiffeId
} from "../../mtls-data-path-contract/src/mtls-data-path.js";
import { enforceConnectivityCanDeploy } from "../../connectivity-policy-enforcement-contract/src/connectivity-policy-enforcement.js";

export const TIER_FIVE_PUBLIC_MTLS_SCHEMA_VERSION = "hobo.tier-five-public-mtls/v1";

export function realizeTierFivePublicMtls(input) {
  if (!isObjectRecord(input)) {
    return invalid("tier5.input.invalid", "input must be an object");
  }

  const planValidation = validateTierFivePlan(input.plan);
  if (!planValidation.ok) return planValidation;

  const policy = enforcePublicTierPolicy(input);
  if (!policy.ok) return { ...policy, failClosed: true };

  let sourceIdentity;
  let targetIdentity;
  try {
    sourceIdentity = parseWorkloadSpiffeId(input.plan.identity.source);
    targetIdentity = parseWorkloadSpiffeId(input.plan.identity.target);
  } catch (error) {
    return invalid("tier5.identity.invalid", error.message);
  }

  if (sourceIdentity.resource !== input.plan.source.resourceId) {
    return invalid(
      "tier5.identity.source-mismatch",
      `source SVID resource ${sourceIdentity.resource} does not match plan source ${input.plan.source.resourceId}`
    );
  }
  if (targetIdentity.resource !== input.plan.target.resourceId) {
    return invalid(
      "tier5.identity.target-mismatch",
      `target SVID resource ${targetIdentity.resource} does not match plan target ${input.plan.target.resourceId}`
    );
  }

  const verbs = normalizeVerbs(input.verbs);
  if (!verbs.ok) return verbs;

  const link = {
    schemaVersion: TIER_FIVE_PUBLIC_MTLS_SCHEMA_VERSION,
    edgeId: input.plan.edgeId,
    tier: ConnectivityTier.PUBLIC_MTLS,
    source: clone(input.plan.source),
    target: clone(input.plan.target),
    sourceSvid: input.plan.identity.source,
    targetSvid: input.plan.identity.target,
    route: {
      transport: "public-mtls",
      publicExposure: true,
      publicEndpointRef: input.plan.parameters.publicEndpointRef,
      publicHost: input.plan.parameters.publicHost,
      publicPort: input.plan.parameters.publicPort,
      fallbackFromTier: input.plan.parameters.fallbackFromTier,
      fallbackReason: input.plan.parameters.fallbackReason
    },
    mtlsPolicy: {
      bindEdgeId: input.plan.edgeId,
      serverSvid: input.plan.identity.target,
      allowedClientSvids: [input.plan.identity.source],
      verbs: verbs.value
    }
  };

  const mtlsContract = {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: `${input.plan.edgeId}:tier5-public-mtls`,
    tenant: targetIdentity.tenant,
    trustDomain: targetIdentity.trustDomain,
    sourceSvid: input.plan.identity.target,
    certMaterialRef: `identity://${targetIdentity.tenant}/${targetIdentity.bindle}/${targetIdentity.resource}/tier5/${input.plan.edgeId}`,
    peerCertificate: input.clientCertificate,
    allowedPeers: [input.plan.identity.source],
    authz: {
      bindEdgeId: input.plan.edgeId,
      verbs: verbs.value
    },
    now: input.now,
    minimumPeerRotationEpoch: input.minimumClientRotationEpoch
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
    topology: topologyForLink(link),
    mtls,
    contract: mtlsContract,
    policy
  };
}

export function canReachTierFiveEndpoint(link, attempt) {
  if (!isObjectRecord(link)) {
    return invalid("tier5.link.invalid", "link must be an object");
  }
  if (!isObjectRecord(attempt)) {
    return invalid("tier5.reachability.invalid", "attempt must be an object");
  }

  if (link.route?.publicExposure !== true || link.tier !== ConnectivityTier.PUBLIC_MTLS) {
    return invalid("tier5.link.not-public", "tier 5 reachability requires a public mTLS link");
  }

  if (attempt.protocol !== "mtls" || !attempt.clientCertificate) {
    return {
      ok: false,
      code: "tier5.mtls.required",
      reason: "tier 5 public endpoint requires mutual TLS with a client SVID certificate",
      failClosed: true
    };
  }

  if (attempt.fromResourceId !== link.source?.resourceId || attempt.toResourceId !== link.target?.resourceId) {
    return invalid(
      "tier5.peer.not-bound",
      `${attempt.fromResourceId} is not the bind edge source for public endpoint ${link.target?.resourceId}`
    );
  }

  if (attempt.clientCertificate.spiffeId !== link.sourceSvid) {
    return invalid(
      "tier5.peer.svid-not-bound",
      `${attempt.clientCertificate.spiffeId} is not the bind-derived client SVID for ${link.source?.resourceId}`
    );
  }

  return { ok: true };
}

function validateTierFivePlan(plan) {
  const validation = validateConnectivityPlan(plan);
  if (!validation.ok) return validation;

  if (plan.tier !== ConnectivityTier.PUBLIC_MTLS) {
    return invalid("tier5.plan.unsupported-tier", "tier 5 realization requires ConnectivityTier.PUBLIC_MTLS");
  }

  if (plan.parameters.mtlsRequired !== true) {
    return invalid("tier5.plan.mtls-required", "tier 5 public endpoint must require mTLS");
  }
  for (const [field, value] of [
    ["parameters.publicEndpointRef", plan.parameters.publicEndpointRef],
    ["parameters.publicHost", plan.parameters.publicHost]
  ]) {
    if (!isString(value) || value.length === 0) {
      return invalid("tier5.plan.public-endpoint-missing", `${field} must be a non-empty string`);
    }
  }
  if (!Number.isInteger(plan.parameters.publicPort) || plan.parameters.publicPort <= 0) {
    return invalid("tier5.plan.public-endpoint-missing", "parameters.publicPort must be a positive integer");
  }

  if (plan.parameters.fallbackFromTier === undefined || plan.parameters.fallbackReason === undefined) {
    return invalid(
      "tier5.plan.invalid-fallback",
      "tier 5 public mTLS realization requires an explicit tier 4 fall-through"
    );
  }
  if (plan.parameters.fallbackFromTier !== ConnectivityTier.OVERLAY_MESH) {
    return invalid("tier5.plan.invalid-fallback", "tier 5 public mTLS fallback must come from tier 4");
  }
  if (!isString(plan.parameters.fallbackReason) || plan.parameters.fallbackReason.length === 0) {
    return invalid("tier5.plan.invalid-fallback", "parameters.fallbackReason must explain the tier 4 fall-through");
  }

  return { ok: true };
}

function enforcePublicTierPolicy(input) {
  if (!input.policyDecision) {
    return { ok: true };
  }

  return enforceConnectivityCanDeploy({
    plan: input.plan,
    environment: input.environment ?? "unknown",
    policyDecision: input.policyDecision
  });
}

function topologyForLink(link) {
  return {
    schemaVersion: TIER_FIVE_PUBLIC_MTLS_SCHEMA_VERSION,
    edges: [
      {
        edgeId: link.edgeId,
        tier: link.tier,
        public: true,
        publicExposure: true,
        mtlsRequired: true,
        sourceResourceId: link.source.resourceId,
        targetResourceId: link.target.resourceId,
        endpoint: `https://${link.route.publicHost}:${link.route.publicPort}`,
        authorizedClientSvids: [...link.mtlsPolicy.allowedClientSvids]
      }
    ]
  };
}

function normalizeVerbs(verbs = ["connect"]) {
  if (!Array.isArray(verbs) || verbs.length === 0) {
    return invalid("tier5.verbs.invalid", "verbs must be a non-empty array");
  }
  const seen = new Set();
  const normalized = [];
  for (const verb of verbs) {
    if (!isString(verb) || verb.length === 0) {
      return invalid("tier5.verbs.invalid", "verbs entries must be non-empty strings");
    }
    if (!seen.has(verb)) {
      seen.add(verb);
      normalized.push(verb);
    }
  }
  return { ok: true, value: normalized };
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
