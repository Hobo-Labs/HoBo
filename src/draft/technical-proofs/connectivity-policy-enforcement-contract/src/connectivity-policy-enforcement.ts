import {
  ConnectivityTier,
  validateConnectivityPlan
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION = "hobo.connectivity-policy-enforcement/v1";

const VALID_TIERS = new Set(Object.values(ConnectivityTier));
const PUBLIC_TIER_NAMES = new Set([
  "5",
  "tier-5",
  "tier5",
  "public",
  "public-endpoint",
  "public-mtls",
  "public+mtls",
  "internet",
  "internet-mtls",
  "external-public-mtls"
]);

const TIER_NAMES = new Map([
  ["1", ConnectivityTier.SAME_PROVIDER_REGION],
  ["tier-1", ConnectivityTier.SAME_PROVIDER_REGION],
  ["same-provider-region", ConnectivityTier.SAME_PROVIDER_REGION],
  ["native-private", ConnectivityTier.SAME_PROVIDER_REGION],
  ["2", ConnectivityTier.SAME_PROVIDER_CROSS_REGION],
  ["tier-2", ConnectivityTier.SAME_PROVIDER_CROSS_REGION],
  ["same-provider-cross-region", ConnectivityTier.SAME_PROVIDER_CROSS_REGION],
  ["cross-region-backbone", ConnectivityTier.SAME_PROVIDER_CROSS_REGION],
  ["3", ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT],
  ["tier-3", ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT],
  ["cross-provider-private-interconnect", ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT],
  ["privatelink", ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT],
  ["psc", ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT],
  ["4", ConnectivityTier.OVERLAY_MESH],
  ["tier-4", ConnectivityTier.OVERLAY_MESH],
  ["overlay", ConnectivityTier.OVERLAY_MESH],
  ["overlay-mesh", ConnectivityTier.OVERLAY_MESH],
  ["wireguard", ConnectivityTier.OVERLAY_MESH],
  ...[...PUBLIC_TIER_NAMES].map((name) => [name, ConnectivityTier.PUBLIC_MTLS])
]);

export function normalizeConnectivityTier(value) {
  if (VALID_TIERS.has(value)) return value;
  if (!isJsonString(value)) return undefined;
  return TIER_NAMES.get(value.trim().toLowerCase());
}

export function enforceConnectivityCanDeploy({ plan, environment, policyDecision }) {
  const planValidation = validateConnectivityPlan(plan);
  if (!planValidation.ok) return failure(planValidation.code, planValidation.reason, {});

  const planTier = normalizeConnectivityTier(plan.tier);
  const requestedTier = normalizeRequestedTier(plan);
  if (!requestedTier) {
    return failure("connectivity.tier-name.unsupported", "requested tier name is not a known connectivity tier", {});
  }

  const request = buildCanDeployRequest({ plan, environment, planTier, requestedTier });
  const decisionValidation = validatePolicyDecision(policyDecision, "can-deploy");
  if (!decisionValidation.ok) {
    return failure(decisionValidation.code, decisionValidation.reason, { request });
  }

  const ceiling = evaluateMandatoryConstraints({
    requestedTier,
    externalEgress: request.context.externalEgress,
    constraints: policyDecision.constraints
  });
  if (ceiling.blocked && ceiling.kind === "tier" && plan.override) {
    return deniedResult({
      code: "connectivity.override.policy-widening",
      reason: ceiling.reason,
      eventType: "connectivity.PolicyBlocked",
      plan,
      request,
      policyDecision,
      requestedTier
    });
  }

  if (policyDecision.effect === "deny") {
    return deniedResult({
      code: "connectivity.policy.denied",
      reason: policyDecision.reason,
      eventType: "connectivity.PolicyBlocked",
      plan,
      request,
      policyDecision,
      requestedTier
    });
  }

  if (ceiling.blocked) {
    return deniedResult({
      code: "connectivity.policy.inconsistent-allow",
      reason: ceiling.reason,
      eventType: "connectivity.PolicyBlocked",
      plan,
      request,
      policyDecision,
      requestedTier
    });
  }

  return {
    ok: true,
    request,
    enforcementEvent: enforcementEvent("connectivity.PolicyAllowed", {
      plan,
      request,
      policyDecision,
      requestedTier
    })
  };
}

export function gateRuntimeResidencyRead({ stream, topologySnapshot, policyDecision }) {
  const streamValidation = validateResidencyStream(stream);
  if (!streamValidation.ok) return failure(streamValidation.code, streamValidation.reason, {});

  if (!topologySnapshot || !Number.isInteger(topologySnapshot.seq)) {
    return failure("connectivity.topology.invalid", "topologySnapshot.seq must be an integer", {});
  }

  const decisionValidation = validatePolicyDecision(policyDecision, "runtime");
  if (!decisionValidation.ok) {
    return failure(decisionValidation.code, decisionValidation.reason, {});
  }

  const request = buildRuntimeResidencyRequest({ stream, topologySnapshot });
  if (policyDecision.evidence?.topologySeq !== topologySnapshot.seq) {
    return failure("connectivity.runtime.regate-required", "runtime topology changed after policy decision", {
      request,
      enforcementEvent: enforcementEvent("connectivity.RuntimeResidencyRegateRequired", {
        stream,
        request,
        policyDecision
      })
    });
  }

  if (policyDecision.effect === "deny") {
    return failure("connectivity.residency.denied", policyDecision.reason, {
      request,
      enforcementEvent: enforcementEvent("connectivity.RuntimeResidencyDenied", {
        stream,
        request,
        policyDecision
      })
    });
  }

  const pin = findRegionPin(policyDecision.obligations);
  const allowedRegions = stream.dataResidency.allowedRegions;
  const targetRegionAllowed = allowedRegions.includes(stream.targetCamp.region);
  if (!targetRegionAllowed) {
    if (pin && allowedRegions.includes(pin.region)) {
      return {
        ok: true,
        mode: "region-pinned",
        request,
        route: {
          streamId: stream.streamId,
          sourceCampId: stream.sourceCamp.id,
          targetCampId: stream.targetCamp.id,
          pinnedRegion: pin.region
        },
        enforcementEvent: enforcementEvent("connectivity.ResidencyPinned", {
          stream,
          request,
          policyDecision,
          pinnedRegion: pin.region
        })
      };
    }

    return failure(
      "connectivity.residency.unpinned-cross-region",
      `stream ${stream.streamId} targets ${stream.targetCamp.region}, outside allowed residency regions`,
      {
        request,
        enforcementEvent: enforcementEvent("connectivity.RuntimeResidencyDenied", {
          stream,
          request,
          policyDecision
        })
      }
    );
  }

  return {
    ok: true,
    mode: "allowed",
    request,
    route: {
      streamId: stream.streamId,
      sourceCampId: stream.sourceCamp.id,
      targetCampId: stream.targetCamp.id,
      targetRegion: stream.targetCamp.region
    },
    enforcementEvent: enforcementEvent("connectivity.RuntimeResidencyAllowed", {
      stream,
      request,
      policyDecision
    })
  };
}

function normalizeRequestedTier(plan) {
  const override = plan.override;
  if (!override) return normalizeConnectivityTier(plan.tier);
  return normalizeConnectivityTier(
    override.requestedTier ??
    override.requestedTierName ??
    override.tier ??
    override.tierName ??
    plan.tier
  );
}

function buildCanDeployRequest({ plan, environment, planTier, requestedTier }) {
  return {
    schemaVersion: CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION,
    phase: "can-deploy",
    action: "connectivity:can-deploy",
    resource: `connectivity-edge:${plan.edgeId}`,
    context: {
      environment,
      edgeId: plan.edgeId,
      tier: planTier,
      requestedTier,
      publicExposure: requestedTier === ConnectivityTier.PUBLIC_MTLS,
      externalEgress: plan.source.yardId !== plan.target.yardId,
      overrideSource: plan.override?.source
    }
  };
}

function buildRuntimeResidencyRequest({ stream, topologySnapshot }) {
  return {
    schemaVersion: CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION,
    phase: "runtime",
    action: "connectivity:read-stream",
    resource: `stream:${stream.streamId}`,
    context: {
      streamId: stream.streamId,
      residencyTag: stream.dataResidency.tag,
      allowedRegions: [...stream.dataResidency.allowedRegions],
      sourceCampId: stream.sourceCamp.id,
      sourceRegion: stream.sourceCamp.region,
      targetCampId: stream.targetCamp.id,
      targetRegion: stream.targetCamp.region,
      topologySeq: topologySnapshot.seq
    }
  };
}

function evaluateMandatoryConstraints({ requestedTier, externalEgress, constraints = {} }) {
  const maxTier = normalizeConnectivityTier(constraints.maxTier);
  if (maxTier && requestedTier > maxTier) {
    return {
      blocked: true,
      kind: "tier",
      reason: `requested tier ${requestedTier} exceeds mandatory max tier ${maxTier}`
    };
  }

  const forbiddenTiers = new Set((constraints.forbiddenTiers ?? []).map(normalizeConnectivityTier));
  if (forbiddenTiers.has(requestedTier)) {
    return {
      blocked: true,
      kind: "tier",
      reason: `requested tier ${requestedTier} is forbidden by mandatory policy`
    };
  }

  if (constraints.forbidExternalEgress === true && externalEgress) {
    return {
      blocked: true,
      kind: "external-egress",
      reason: "cross-Yard external egress is forbidden by mandatory policy"
    };
  }

  return { blocked: false };
}

function validatePolicyDecision(decision, phase) {
  if (!decision || !isJsonObject(decision) || Array.isArray(decision)) {
    return invalid("connectivity.policy-decision.invalid", "policyDecision must be an object");
  }
  if (decision.phase !== phase) {
    return invalid("connectivity.policy-decision.phase", `policyDecision.phase must be ${phase}`);
  }
  if (!["allow", "deny"].includes(decision.effect)) {
    return invalid("connectivity.policy-decision.effect", "policyDecision.effect must be allow or deny");
  }
  if (!isJsonString(decision.decisionId) || decision.decisionId.length === 0) {
    return invalid("connectivity.policy-decision.id", "policyDecision.decisionId must be a non-empty string");
  }
  return { ok: true };
}

function validateResidencyStream(stream) {
  if (!stream || !isJsonObject(stream) || Array.isArray(stream)) {
    return invalid("connectivity.stream.invalid", "stream must be an object");
  }
  for (const [field, value] of [
    ["streamId", stream.streamId],
    ["sourceCamp.id", stream.sourceCamp?.id],
    ["sourceCamp.region", stream.sourceCamp?.region],
    ["targetCamp.id", stream.targetCamp?.id],
    ["targetCamp.region", stream.targetCamp?.region],
    ["dataResidency.tag", stream.dataResidency?.tag]
  ]) {
    if (!isJsonString(value) || value.length === 0) {
      return invalid("connectivity.stream.required-field", `${field} must be a non-empty string`);
    }
  }
  if (!Array.isArray(stream.dataResidency.allowedRegions) || stream.dataResidency.allowedRegions.length === 0) {
    return invalid("connectivity.stream.residency", "dataResidency.allowedRegions must be a non-empty array");
  }
  if (stream.dataResidency.allowedRegions.some((region) => !isJsonString(region) || region.length === 0)) {
    return invalid("connectivity.stream.residency", "dataResidency.allowedRegions entries must be non-empty strings");
  }
  return { ok: true };
}

function findRegionPin(obligations = []) {
  return obligations.find((obligation) => (
    obligation &&
    obligation.type === "region-pin" &&
    isJsonString(obligation.region) &&
    obligation.region.length > 0
  ));
}

function deniedResult({ code, reason, eventType, plan, request, policyDecision, requestedTier }) {
  return failure(code, reason, {
    request,
    enforcementEvent: enforcementEvent(eventType, {
      plan,
      request,
      policyDecision,
      requestedTier
    })
  });
}

function enforcementEvent(type, { plan, stream, request, policyDecision, requestedTier, pinnedRegion }) {
  return {
    schemaVersion: CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION,
    type,
    data: {
      edgeId: plan?.edgeId,
      streamId: stream?.streamId,
      phase: request?.phase,
      action: request?.action,
      decisionId: policyDecision?.decisionId,
      effect: policyDecision?.effect,
      reason: policyDecision?.reason,
      policyIds: [...(policyDecision?.evidence?.policyIds ?? [])],
      requestedTier,
      pinnedRegion
    }
  };
}

function failure(code, reason, extras) {
  return {
    ok: false,
    code,
    reason,
    ...extras
  };
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}
