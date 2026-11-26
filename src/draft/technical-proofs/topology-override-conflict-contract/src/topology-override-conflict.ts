import { createHash } from "node:crypto";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { normalizeConnectivityTier } from "../../connectivity-policy-enforcement-contract/src/connectivity-policy-enforcement.js";
import { validateJunctionConnectivityPlan } from "../../junction-connectivity-plan-contract/src/junction-connectivity-plan.js";
import { isJsonString, isJsonObject } from "./json.js";


export const TOPOLOGY_OVERRIDE_CONFLICT_SCHEMA_VERSION = "hobo.topology-override-conflict/v1";

const VALID_OVERRIDE_KINDS = new Set(["dns-record", "connectivity-tier"]);
const VALID_SCOPES = new Set(["yard", "camp"]);

export function evaluateTopologyOverrideCanDeploy({
  inferredPlan,
  closedInference,
  overrides = [],
  policyDecision,
  topologySeq
}) {
  const overrideValidation = validateOverrides(overrides);
  if (!overrideValidation.ok) return overrideValidation;

  const policyValidation = validatePolicyDecision(policyDecision);
  if (!policyValidation.ok) return policyValidation;

  if (closedInference && closedInference.ok === false) {
    const reopeningOverride = overrides.find((override) => (
      override.kind === "connectivity-tier" &&
      normalizeConnectivityTier(override.requestedTier) === ConnectivityTier.PUBLIC_MTLS
    ));

    if (reopeningOverride) {
      return failure({
        code: "topology.override.reopens-closed-path",
        reason: `override ${reopeningOverride.id} cannot re-open an inference closed by ${closedInference.code}`,
        type: "topology.OverrideDenied",
        overrides,
        topologySeq
      });
    }
  }

  const planValidation = validateJunctionConnectivityPlan(inferredPlan);
  if (!planValidation.ok) return planValidation;

  const inferenceHash = inferredPlan.junctionEvent?.contentHash;
  for (const override of sortedOverrides(overrides)) {
    const regate = staleBasis(override, { inferenceHash, topologySeq });
    if (regate) {
      return failure({
        code: "topology.override.regate-required",
        reason: regate.reason,
        type: "topology.OverrideRegateRequired",
        overrides,
        inferenceHash,
        topologySeq,
        conflict: conflictFor("regate", [override])
      });
    }
  }

  const scopeConflict = findScopeConflict(overrides);
  if (scopeConflict) {
    return failure({
      code: "topology.override.scope-conflict",
      reason: `overrides disagree for ${scopeConflict.key}`,
      type: "topology.OverrideConflictDetected",
      overrides,
      inferenceHash,
      topologySeq,
      conflict: scopeConflict
    });
  }

  const edgesById = new Map((inferredPlan.edges ?? []).map((edge) => [edge.id, edge]));
  for (const override of sortedOverrides(overrides)) {
    const edge = edgesById.get(override.edgeId);
    if (!edge) {
      return failure({
        code: "topology.override.unknown-edge",
        reason: `override ${override.id} references unknown inferred edge ${override.edgeId}`,
        type: "topology.OverrideDenied",
        overrides,
        inferenceHash,
        topologySeq
      });
    }

    if (override.kind === "dns-record") {
      const conflict = dnsConflict(edge, override);
      if (conflict) {
        return failure({
          code: "topology.override.conflict",
          reason: `override ${override.id} conflicts with inferred DNS ${conflict.recordKey}`,
          type: "topology.OverrideConflictDetected",
          overrides,
          inferenceHash,
          topologySeq,
          conflict
        });
      }
      continue;
    }

    const requestedTier = normalizeConnectivityTier(override.requestedTier);
    const ceiling = mandatoryTierCeiling({ override, requestedTier, policyDecision });
    if (ceiling.blocked) {
      return failure({
        code: "topology.override.policy-widening",
        reason: ceiling.reason,
        type: "topology.OverrideDenied",
        overrides,
        inferenceHash,
        topologySeq,
        conflict: conflictFor("policy", [override])
      });
    }

    const residency = residencyConflict(edge, override);
    if (residency) {
      return failure({
        code: "topology.override.residency-violation",
        reason: residency.reason,
        type: "topology.OverrideDenied",
        overrides,
        inferenceHash,
        topologySeq,
        conflict: residency
      });
    }

    if (requestedTier !== edge.tier) {
      return failure({
        code: "topology.override.conflict",
        reason: `override ${override.id} requested tier ${requestedTier} but inference selected tier ${edge.tier}`,
        type: "topology.OverrideConflictDetected",
        overrides,
        inferenceHash,
        topologySeq,
        conflict: conflictFor(edge.id, [override], { inferredTier: edge.tier, requestedTier })
      });
    }
  }

  if (policyDecision.effect === "deny") {
    return failure({
      code: "topology.override.policy-denied",
      reason: policyDecision.reason,
      type: "topology.OverrideDenied",
      overrides,
      inferenceHash,
      topologySeq
    });
  }

  return {
    ok: true,
    phase: "can-deploy",
    decisionEvent: decisionEvent("topology.OverrideAccepted", {
      overrides,
      inferenceHash,
      topologySeq,
      policyDecision
    })
  };
}

function validateOverrides(overrides) {
  if (!Array.isArray(overrides)) {
    return invalid("topology.override.invalid", "overrides must be an array");
  }

  for (const override of overrides) {
    for (const [field, value] of [
      ["id", override?.id],
      ["scope", override?.scope],
      ["scopeId", override?.scopeId],
      ["kind", override?.kind],
      ["edgeId", override?.edgeId],
      ["reason", override?.reason]
    ]) {
      if (!isNonEmptyString(value)) {
        return invalid("topology.override.required-field", `override.${field} must be a non-empty string`);
      }
    }
    if (!VALID_SCOPES.has(override.scope)) {
      return invalid("topology.override.scope", "override.scope must be yard or camp");
    }
    if (!VALID_OVERRIDE_KINDS.has(override.kind)) {
      return invalid("topology.override.kind", "override.kind must be dns-record or connectivity-tier");
    }
    if (override.kind === "dns-record") {
      if (!isNonEmptyString(override.recordName) || !isNonEmptyString(override.type)) {
        return invalid("topology.override.required-field", "DNS overrides require recordName and type");
      }
      if (!Array.isArray(override.targets) || override.targets.length === 0 || override.targets.some((target) => !isNonEmptyString(target))) {
        return invalid("topology.override.required-field", "DNS overrides require non-empty targets");
      }
    } else if (!normalizeConnectivityTier(override.requestedTier)) {
      return invalid("topology.override.tier", `override ${override.id} requested an unsupported tier`);
    }
  }

  return { ok: true };
}

function validatePolicyDecision(policyDecision) {
  if (!policyDecision || !isJsonObject(policyDecision) || Array.isArray(policyDecision)) {
    return invalid("topology.policy-decision.invalid", "policyDecision must be an object");
  }
  if (policyDecision.phase !== "can-deploy") {
    return invalid("topology.policy-decision.phase", "policyDecision.phase must be can-deploy");
  }
  if (!["allow", "deny"].includes(policyDecision.effect)) {
    return invalid("topology.policy-decision.effect", "policyDecision.effect must be allow or deny");
  }
  if (!isNonEmptyString(policyDecision.decisionId)) {
    return invalid("topology.policy-decision.id", "policyDecision.decisionId must be a non-empty string");
  }
  return { ok: true };
}

function staleBasis(override, { inferenceHash, topologySeq }) {
  const basis = override.basis ?? {};
  if (Number.isInteger(basis.topologySeq) && Number.isInteger(topologySeq) && basis.topologySeq !== topologySeq) {
    return {
      reason: `override ${override.id} was based on stale topology seq ${basis.topologySeq}; current seq is ${topologySeq}`
    };
  }
  if (isNonEmptyString(basis.inferenceHash) && isNonEmptyString(inferenceHash) && basis.inferenceHash !== inferenceHash) {
    return {
      reason: `override ${override.id} was based on stale inference hash`
    };
  }
  return null;
}

function findScopeConflict(overrides) {
  const grouped = new Map();
  for (const override of sortedOverrides(overrides)) {
    const key = overrideKey(override);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(override);
  }

  for (const [key, group] of grouped) {
    const intents = new Set(group.map(overrideIntent));
    const scopes = new Set(group.map((override) => override.scope));
    if (intents.size > 1 && scopes.size > 1) {
      return conflictFor(key, group, {
        key,
        participants: group.map((override) => ({
          id: override.id,
          scope: override.scope,
          scopeId: override.scopeId,
          intent: overrideIntent(override)
        }))
      });
    }
  }

  return null;
}

function dnsConflict(edge, override) {
  const recordKey = `${override.recordName}:${override.type}`;
  const inferredRule = (edge.dnsRules ?? []).find((rule) => `${rule.recordName}:${rule.type}` === recordKey);
  if (!inferredRule) return null;
  if (canonicalJson(sortedStrings(inferredRule.targets)) === canonicalJson(sortedStrings(override.targets))) return null;

  return conflictFor(edge.id, [override], {
    edgeId: edge.id,
    recordKey,
    inferredTargets: sortedStrings(inferredRule.targets),
    overrideTargets: sortedStrings(override.targets)
  });
}

function mandatoryTierCeiling({ override, requestedTier, policyDecision }) {
  const constraints = policyDecision.constraints ?? {};
  const maxTier = normalizeConnectivityTier(constraints.maxTier);
  if (maxTier && requestedTier > maxTier) {
    return {
      blocked: true,
      reason: `override ${override.id} requested tier ${requestedTier} beyond mandatory max tier ${maxTier}`
    };
  }

  const forbiddenTiers = new Set((constraints.forbiddenTiers ?? []).map(normalizeConnectivityTier));
  if (forbiddenTiers.has(requestedTier)) {
    return {
      blocked: true,
      reason: `override ${override.id} requested forbidden tier ${requestedTier}`
    };
  }

  return { blocked: false };
}

function residencyConflict(edge, override) {
  if (!override.residencyTag) return null;
  const inferredResidency = edge.source?.residencyTag;
  if (override.residencyTag === inferredResidency && override.residencyTag === edge.target?.residencyTag) return null;

  return conflictFor(edge.id, [override], {
    edgeId: edge.id,
    reason: `override ${override.id} changes residency ${inferredResidency} -> ${override.residencyTag} for edge ${edge.id}`
  });
}

function overrideKey(override) {
  if (override.kind === "dns-record") {
    return `${override.edgeId}:dns:${override.recordName}:${override.type}`;
  }
  return `${override.edgeId}:tier`;
}

function overrideIntent(override) {
  if (override.kind === "dns-record") {
    return canonicalJson({
      kind: override.kind,
      targets: sortedStrings(override.targets)
    });
  }
  return canonicalJson({
    kind: override.kind,
    requestedTier: normalizeConnectivityTier(override.requestedTier),
    residencyTag: override.residencyTag
  });
}

function failure({ code, reason, type, overrides, inferenceHash, topologySeq, conflict }) {
  return {
    ok: false,
    phase: "can-deploy",
    code,
    reason,
    ...(conflict ? { conflict } : undefined),
    decisionEvent: decisionEvent(type, {
      overrides,
      inferenceHash,
      topologySeq,
      code,
      reason,
      conflict
    })
  };
}

function decisionEvent(type, { overrides = [], inferenceHash, topologySeq, policyDecision, code, reason, conflict }) {
  return {
    schemaVersion: TOPOLOGY_OVERRIDE_CONFLICT_SCHEMA_VERSION,
    type,
    data: {
      phase: "can-deploy",
      action: "topology:can-deploy",
      overrideIds: sortedOverrides(overrides).map((override) => override.id),
      inferenceHash,
      topologySeq,
      policyDecisionId: policyDecision?.decisionId,
      code,
      reason,
      conflictId: conflict?.conflictId
    }
  };
}

function conflictFor(seed, overrides, extra = {}) {
  const participants = extra.participants ?? sortedOverrides(overrides).map((override) => ({
    id: override.id,
    scope: override.scope,
    scopeId: override.scopeId
  }));
  const content = {
    seed,
    participants,
    ...extra
  };
  return {
    ...extra,
    participants,
    conflictId: stableDigest(content)
  };
}

function sortedOverrides(overrides) {
  return [...overrides].sort((left, right) => `${left.id}:${left.scope}:${left.scopeId}`.localeCompare(`${right.id}:${right.scope}:${right.scopeId}`));
}

function sortedStrings(values) {
  return [...values].map(String).sort();
}

function invalid(code, reason) {
  return { ok: false, code, reason };
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.length > 0;
}

function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
