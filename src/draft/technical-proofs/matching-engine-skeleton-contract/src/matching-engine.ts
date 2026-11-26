import { createMatchDecidedEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { specificity } from "../../matching-specificity-vectors/src/matching.js";
import { isJsonString, isJsonObject } from "./json.js";


export const MATCHING_ENGINE_VERSION = "hobo.matching-engine/v1";

const OBJECTIVES = new Set(["cost", "latency", "single-provider", "carbon", "maximize-credits"]);

const DETAIL_ORDER = Object.freeze([
  "resourceId",
  "resourceClass",
  "tenant",
  "app",
  "env",
  "envType"
]);

export function decideResourceDefinition({ catalog, context, objective = "cost" }) {
  assertContext(context);
  assertObjective(objective);
  const snapshot = catalogSnapshot(catalog);
  const definitions = snapshot.definitions.filter((definition) => definition.type === context.resourceType);
  const catalogContentHash = hashRef(snapshot.contentHash);

  if (definitions.length === 0) {
    return failedDecision({
      context,
      objective,
      catalogContentHash,
      reason: `no ResourceDefinition candidates for ${context.resourceType}`,
      rejectedCandidates: []
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

    candidates.push(rankCandidate(definition));
  }

  if (candidates.length === 0) {
    return failedDecision({
      context,
      objective,
      catalogContentHash,
      reason: `no matching ResourceDefinition for ${context.resourceType}`,
      rejectedCandidates
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

  return {
    ok: true,
    schema: MATCHING_ENGINE_VERSION,
    context: { ...context },
    objective,
    catalogContentHash,
    winner,
    ranking: ranked.map(publicRank),
    rejectedCandidates,
    tie,
    tiedDefinitionIds,
    planWarnings: tie
      ? [`true tie between ${tiedDefinitionIds.join(", ")}; add priority to disambiguate`]
      : []
  };
}

export function matchingDecisionToEvent(decision, overrides = {}) {
  if (!decision?.ok) {
    throw new Error(`cannot emit match.Decided for failed decision: ${decision?.reason ?? "unknown"}`);
  }

  return createMatchDecidedEvent({
    resourceId: decision.context.resourceId ?? decision.context.resourceType,
    winner: decision.winner.id,
    ranking: decision.ranking,
    rejectedCandidates: decision.rejectedCandidates,
    objective: decision.objective,
    tie: decision.tie,
    catalogContentHash: decision.catalogContentHash
  }, overrides);
}

export function rankingSummary(decision) {
  return (decision?.ranking ?? []).map((entry) => entry.definitionId);
}

function failedDecision({ context, objective, catalogContentHash, reason, rejectedCandidates }) {
  return {
    ok: false,
    schema: MATCHING_ENGINE_VERSION,
    context: { ...context },
    objective,
    catalogContentHash,
    reason,
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

function rankCandidate(definition) {
  const rankedSpecificity = specificity(definition.match ?? {});
  return {
    definition,
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

function matchMismatch(match, context) {
  const reasons = [];
  for (const [field, expected] of Object.entries(match)) {
    if (context[field] !== expected) {
      reasons.push(`${field}=${String(expected)} does not match ${String(context[field])}`);
    }
  }
  return reasons;
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

function hashRef(contentHash) {
  return contentHash.startsWith("sha256:") ? contentHash : `sha256:${contentHash}`;
}

function descending(left, right) {
  return left > right ? -1 : left < right ? 1 : 0;
}
