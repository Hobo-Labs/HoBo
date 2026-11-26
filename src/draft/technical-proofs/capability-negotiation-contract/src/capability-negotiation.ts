import { createHash } from "node:crypto";

import { createMatchDecidedEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { specificity } from "../../matching-specificity-vectors/src/matching.js";
import { isJsonString, isJsonObject } from "./json.js";


export const CAPABILITY_NEGOTIATION_VERSION = "hobo.capability-negotiation/v1";

const OBJECTIVES = new Set(["cost", "latency", "single-provider", "carbon", "maximize-credits"]);
const STRICTNESS = new Set(["require", "prefer"]);
const DETAIL_ORDER = Object.freeze([
  "resourceId",
  "resourceClass",
  "tenant",
  "app",
  "env",
  "envType"
]);

export function defineCapability({ provider, port, features, remediation }) {
  assertString(provider, "provider");
  assertString(port, "port");
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error("features must be a non-empty array");
  }

  return deepFreeze({
    provider,
    port,
    features: [...new Set(features)].sort(),
    remediation
  });
}

export function capabilityRequest({ port, features, strictness = "require" }) {
  assertString(port, "port");
  assertStrictness(strictness);
  if (!Array.isArray(features) || features.length === 0) {
    throw new Error("features must be a non-empty array");
  }

  return deepFreeze({
    port,
    features: [...new Set(features)].sort(),
    strictness
  });
}

export function decideCapabilityNegotiatedDefinition({
  catalog,
  context,
  portRequests,
  capabilitiesByProvider,
  objective = "cost"
}) {
  assertContext(context);
  assertObjective(objective);
  const snapshot = catalogSnapshot(catalog);
  const catalogContentHash = hashRef(snapshot.contentHash);
  const definitions = snapshot.definitions.filter((definition) => definition.type === context.resourceType);
  const normalizedRequests = normalizePortRequests(portRequests);

  if (definitions.length === 0) {
    return failedDecision({
      context,
      objective,
      catalogContentHash,
      reason: `no ResourceDefinition candidates for ${context.resourceType}`,
      rejectedCandidates: [],
      rejectionCode: "resource-definition.none"
    });
  }

  const rejectedCandidates = [];
  const candidates = [];

  for (const definition of definitions) {
    const mismatch = matchMismatch(definition.match ?? {}, context);
    if (mismatch.length > 0) {
      rejectedCandidates.push({
        definitionId: definition.id,
        reason: mismatch.join("; ")
      });
      continue;
    }

    const capability = evaluateDefinitionCapabilities({
      definition,
      normalizedRequests,
      capabilitiesByProvider
    });

    if (!capability.accepted) {
      rejectedCandidates.push({
        definitionId: definition.id,
        reason: capability.reason,
        missingCapabilities: capability.missing
      });
      continue;
    }

    candidates.push(rankCandidate(definition, capability));
  }

  if (candidates.length === 0) {
    const hasCapabilityReject = rejectedCandidates.some((candidate) =>
      candidate.reason.startsWith("capability.require.unsatisfied")
    );

    return failedDecision({
      context,
      objective,
      catalogContentHash,
      reason: hasCapabilityReject
        ? `capability.require.unsatisfied resourceType=${context.resourceType} missing=${formatRejectedMissing(rejectedCandidates)}`
        : `no matching ResourceDefinition for ${context.resourceType}`,
      rejectedCandidates,
      rejectionCode: hasCapabilityReject ? "capability.require.unsatisfied" : "resource-definition.no-match"
    });
  }

  const ranked = candidates.sort(compareCandidates).map((candidate, index) => ({
    ...candidate,
    rank: index + 1
  }));
  const winner = ranked[0].definition;
  const tiedDefinitionIds = ranked
    .filter((candidate) => compareBeforeStableId(candidate, ranked[0]) === 0)
    .map((candidate) => candidate.definition.id);
  const tie = tiedDefinitionIds.length > 1;
  const winnerWarnings = ranked[0].capability.planWarnings;
  const planWarnings = [
    ...winnerWarnings,
    ...(tie ? [`true tie between ${tiedDefinitionIds.join(", ")}; add priority to disambiguate`] : [])
  ];

  return {
    ok: true,
    schema: CAPABILITY_NEGOTIATION_VERSION,
    context: { ...context },
    objective,
    catalogContentHash,
    winner,
    ranking: ranked.map(publicRank),
    rejectedCandidates,
    tie,
    tiedDefinitionIds,
    planWarnings,
    capability: {
      provider: winner.provider,
      level: ranked[0].capability.level,
      missingPreferred: ranked[0].capability.missingPreferred
    }
  };
}

export function capabilityDecisionToMatchEvent(decision, overrides = {}) {
  if (!decision?.ok) {
    throw new Error(`cannot emit match.Decided for failed capability decision: ${decision?.reason ?? "unknown"}`);
  }

  return createMatchDecidedEvent({
    resourceId: decision.context.resourceId ?? decision.context.resourceType,
    winner: decision.winner.id,
    ranking: decision.ranking,
    rejectedCandidates: decision.rejectedCandidates.map(publicRejectedCandidate),
    objective: decision.objective,
    tie: decision.tie,
    catalogContentHash: decision.catalogContentHash
  }, overrides);
}

export function capabilityDecisionToPlanRejectedEvent(decision, overrides = {}) {
  if (decision?.ok) {
    throw new Error("cannot emit deployment.PlanRejected for successful capability decision");
  }

  const deploymentId = overrides.deploymentId ?? decision.context.deploymentId ?? "dep-capability-negotiation";
  const data = {
    deploymentId,
    reason: decision.reason
  };

  return {
    id: overrides.id ?? `evt-${stableDigest({ type: "deployment.PlanRejected", data }).slice(0, 12)}`,
    type: "deployment.PlanRejected",
    schemaVersion: 1,
    tenant: overrides.tenant ?? "tenant-hobo",
    seq: overrides.seq ?? 0,
    time: overrides.time ?? "2026-06-25T00:00:00.000Z",
    actor: overrides.actor ?? { kind: "service", id: "yard/planner" },
    correlationId: overrides.correlationId ?? "corr-capability-negotiation",
    causationId: overrides.causationId ?? "cmd-plan",
    data
  };
}

function evaluateDefinitionCapabilities({ definition, normalizedRequests, capabilitiesByProvider }) {
  const providerCapabilities = capabilitiesForProvider(capabilitiesByProvider, definition.provider);
  const warnings = normalizedRequests.conflicts.map((conflict) => ({
    kind: "capability.strictness-conflict",
    port: conflict.port,
    feature: conflict.feature,
    resolution: "require"
  }));
  const missingRequired = [];
  const missingPreferred = [];

  for (const request of normalizedRequests.requests) {
    const capability = providerCapabilities.find((candidate) => candidate.port === request.port);
    const supported = capability?.features?.includes(request.feature) ?? false;

    if (supported) {
      continue;
    }

    const missing = {
      port: request.port,
      feature: request.feature,
      reason: capability ? "feature-missing" : "capability-unavailable",
      remediation: capability?.remediation
    };

    if (request.strictness === "require") {
      missingRequired.push(missing);
    } else {
      missingPreferred.push(missing);
    }
  }

  if (missingRequired.length > 0) {
    return {
      accepted: false,
      level: capabilityLevel(providerCapabilities, normalizedRequests.requests),
      missing: missingRequired,
      reason: `capability.require.unsatisfied provider=${definition.provider} missing=${formatMissing(missingRequired)}`
    };
  }

  if (missingPreferred.length > 0) {
    return {
      accepted: true,
      level: capabilityLevel(providerCapabilities, normalizedRequests.requests),
      missingPreferred,
      planWarnings: [
        ...warnings,
        ...missingPreferred.map((missing) => ({
          kind: "capability.prefer.degraded",
          provider: definition.provider,
          port: missing.port,
          feature: missing.feature,
          reason: missing.reason,
          remediation: missing.remediation
        }))
      ]
    };
  }

  return {
    accepted: true,
    level: "full",
    missingPreferred: [],
    planWarnings: warnings
  };
}

function capabilitiesForProvider(capabilitiesByProvider, provider) {
  const raw = capabilitiesByProvider instanceof Map
    ? capabilitiesByProvider.get(provider)
    : capabilitiesByProvider?.[provider];
  if (!raw) return [];
  return raw.map((capability) => ({
    port: capability.port,
    features: [...(capability.features ?? [])],
    remediation: capability.remediation
  }));
}

function normalizePortRequests(portRequests) {
  if (!Array.isArray(portRequests) || portRequests.length === 0) {
    throw new Error("portRequests must be a non-empty array");
  }

  const byKey = new Map();
  const conflicts = [];

  for (const request of portRequests) {
    assertString(request?.port, "portRequest.port");
    assertStrictness(request?.strictness);
    if (!Array.isArray(request.features) || request.features.length === 0) {
      throw new Error("portRequest.features must be a non-empty array");
    }

    for (const feature of request.features) {
      assertString(feature, "portRequest.feature");
      const key = `${request.port}\0${feature}`;
      const existing = byKey.get(key);
      if (existing && existing.strictness !== request.strictness) {
        conflicts.push({ port: request.port, feature });
      }
      byKey.set(key, {
        port: request.port,
        feature,
        strictness: existing?.strictness === "require" || request.strictness === "require"
          ? "require"
          : "prefer"
      });
    }
  }

  return {
    requests: [...byKey.values()].sort((left, right) =>
      `${left.port}:${left.feature}`.localeCompare(`${right.port}:${right.feature}`)
    ),
    conflicts
  };
}

function failedDecision({ context, objective, catalogContentHash, reason, rejectedCandidates, rejectionCode }) {
  return {
    ok: false,
    schema: CAPABILITY_NEGOTIATION_VERSION,
    context: { ...context },
    objective,
    catalogContentHash,
    reason,
    rejection: { code: rejectionCode },
    ranking: [],
    rejectedCandidates,
    tie: false,
    tiedDefinitionIds: [],
    planWarnings: []
  };
}

function catalogSnapshot(catalog) {
  const snapshot = catalog?.snapshot instanceof Function ? catalog.snapshot() : catalog;
  if (!snapshot || !isJsonObject(snapshot) || !Array.isArray(snapshot.definitions)) {
    throw new Error("catalog snapshot with definitions is required");
  }
  if (!isJsonString(snapshot.contentHash) || snapshot.contentHash.length === 0) {
    throw new Error("catalog snapshot contentHash is required");
  }
  return snapshot;
}

function rankCandidate(definition, capability) {
  const rankedSpecificity = specificity(definition.match ?? {});
  return {
    definition,
    capability,
    specificity: rankedSpecificity,
    priority: Number.isInteger(definition.priority) ? definition.priority : 0
  };
}

function compareCandidates(left, right) {
  return compareBeforeStableId(left, right) || left.definition.id.localeCompare(right.definition.id);
}

function compareBeforeStableId(left, right) {
  return (
    descending(left.specificity.score, right.specificity.score) ||
    compareDetail(left.specificity.detail, right.specificity.detail) ||
    descending(left.specificity.dimensionCount, right.specificity.dimensionCount) ||
    descending(left.priority, right.priority)
  );
}

function compareDetail(left, right) {
  for (const field of DETAIL_ORDER) {
    const comparison = descending(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function publicRank(candidate) {
  return {
    definitionId: candidate.definition.id,
    specificity: candidate.specificity.score,
    priority: candidate.priority,
    objectiveScore: 0,
    rank: candidate.rank
  };
}

function publicRejectedCandidate(candidate) {
  return {
    definitionId: candidate.definitionId,
    reason: candidate.reason
  };
}

function matchMismatch(match, context) {
  const reasons = [];
  for (const [field, expected] of Object.entries(match)) {
    if (context[field] !== expected) {
      reasons.push(`${field}=${String(expected)} does not match ${String(context[field])}`);
    }
  }
  return reasons;
}

function formatMissing(missing) {
  return missing.map((entry) => `${entry.port}.${entry.feature}`).join(",");
}

function formatRejectedMissing(rejectedCandidates) {
  const missing = rejectedCandidates.flatMap((candidate) => candidate.missingCapabilities ?? []);
  if (missing.length === 0) return "unknown";
  return [...new Set(missing.map((entry) => `${entry.port}.${entry.feature}`))].sort().join(",");
}

function capabilityLevel(providerCapabilities, requests) {
  return providerCapabilities.some((capability) =>
    requests.some((request) => request.port === capability.port)
  )
    ? "partial"
    : "none";
}

function assertContext(context) {
  if (!context || !isJsonObject(context) || Array.isArray(context)) {
    throw new Error("context must be an object");
  }
  if (!isJsonString(context.resourceType) || context.resourceType.length === 0) {
    throw new Error("context.resourceType must be a non-empty string");
  }
}

function assertObjective(objective) {
  if (!OBJECTIVES.has(objective)) {
    throw new Error(`objective must be one of ${Array.from(OBJECTIVES).join(", ")}`);
  }
}

function assertStrictness(strictness) {
  if (!STRICTNESS.has(strictness)) {
    throw new Error(`strictness must be one of ${Array.from(STRICTNESS).join(", ")}`);
  }
}

function assertString(value, field) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function hashRef(contentHash) {
  return contentHash.startsWith("sha256:") ? contentHash : `sha256:${contentHash}`;
}

function stableDigest(value) {
  return createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!value || !isJsonObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function descending(left, right) {
  return left > right ? -1 : left < right ? 1 : 0;
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return value;
}
