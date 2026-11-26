import { createHash } from "node:crypto";

import {
  createMatchDecidedEvent,
  createPlannedEvent
} from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import { specificity } from "../../matching-specificity-vectors/src/matching.js";

export const REGION_OBJECTIVE_RANKING_VERSION = "hobo.region-objective-ranking/v1";

const OBJECTIVES = new Set(["cost", "latency", "single-provider", "carbon"]);
const DETAIL_ORDER = Object.freeze([
  "resourceId",
  "resourceClass",
  "tenant",
  "app",
  "env",
  "envType"
]);
const LARGE_SCORE = Number.MAX_SAFE_INTEGER;

export function decideRegionObjectivePlacement({ catalog, context, objective = "cost" }) {
  assertContext(context);
  assertObjective(objective);

  const snapshot = catalogSnapshot(catalog);
  const rejectedCandidates = [];
  const candidates = [];

  for (const definition of snapshot.definitions) {
    const baseReject = rejectDefinition(definition, context);
    if (baseReject) {
      rejectedCandidates.push(baseReject);
      continue;
    }

    const regions = eligibleRegions(definition, context);
    if (regions.length === 0) {
      rejectedCandidates.push({
        definitionId: definition.id,
        reason: "region.colocation.unsatisfied"
      });
      continue;
    }

    for (const region of regions) {
      candidates.push(rankCandidate({ definition, region, context, objective }));
    }
  }

  if (candidates.length === 0) {
    return {
      ok: false,
      schema: REGION_OBJECTIVE_RANKING_VERSION,
      objective,
      reason: "no full candidate satisfies matching and colocation constraints",
      rejectedCandidates
    };
  }

  const ranked = candidates.sort(compareCandidates).map((candidate, index) => ({
    ...candidate,
    rank: index + 1
  }));
  const winner = ranked[0];
  const tiedDefinitionIds = ranked
    .filter((candidate) => compareBeforeStableId(candidate, winner) === 0)
    .map((candidate) => candidate.definition.id);
  const tie = tiedDefinitionIds.length > 1;
  const ranking = ranked.map(publicRank);
  const catalogContentHash = hashRef(snapshot.contentHash);
  const rejected = rejectedCandidates.map(publicRejected);
  const matchEvent = createMatchDecidedEvent({
    resourceId: context.resourceId,
    winner: winner.definition.id,
    ranking,
    rejectedCandidates: rejected,
    objective,
    tie,
    catalogContentHash
  });
  const deploymentPlan = createDeploymentPlan({
    context,
    objective,
    catalogContentHash,
    matchDecisionId: matchEvent.id,
    winner,
    rankedCandidates: ranked,
    ranking,
    rejectedCandidates: rejected,
    tie
  });
  const plannedEvent = createPlannedEvent(deploymentPlan);

  return {
    ok: true,
    schema: REGION_OBJECTIVE_RANKING_VERSION,
    objective,
    catalogContentHash,
    winner: {
      definitionId: winner.definition.id,
      provider: winner.definition.provider,
      region: winner.region.id
    },
    ranking,
    rejectedCandidates: rejected,
    tie,
    tiedDefinitionIds,
    deploymentPlan,
    matchEvent,
    plannedEvent
  };
}

function rejectDefinition(definition, context) {
  if (!isObjectRecord(definition)) {
    return { definitionId: "<unknown>", reason: "definition must be an object" };
  }
  if (!isNonEmptyString(definition.id)) {
    return { definitionId: "<unknown>", reason: "definition.id is required" };
  }
  if (definition.type !== context.resourceType) {
    return {
      definitionId: definition.id,
      reason: `type ${String(definition.type)} does not match ${context.resourceType}`
    };
  }
  if (definition.capability !== "full") {
    return {
      definitionId: definition.id,
      reason: `capability ${String(definition.capability)} is not full`
    };
  }
  try {
    specificity(definition.match ?? {});
  } catch (error) {
    return {
      definitionId: definition.id,
      reason: error.message
    };
  }
  const mismatch = matchMismatch(definition.match ?? {}, context);
  if (mismatch.length > 0) {
    return { definitionId: definition.id, reason: mismatch.join("; ") };
  }
  return null;
}

function eligibleRegions(definition, context) {
  if (!Array.isArray(definition.regions) || definition.regions.length === 0) return [];

  return definition.regions.filter((region) => {
    if (!isNonEmptyString(region?.id)) return false;
    if (context.explicitRegion && region.id !== context.explicitRegion) return false;
    if (Array.isArray(context.allowedRegions) && !context.allowedRegions.includes(region.id)) {
      return false;
    }
    return (context.colocated ?? []).every((resource) =>
      !Array.isArray(resource.allowedRegions) || resource.allowedRegions.includes(region.id)
    );
  });
}

function rankCandidate({ definition, region, context, objective }) {
  const selectedSpecificity = specificity(definition.match ?? {});
  const objectiveVector = compareVector({ definition, region, context, objective });
  return {
    definition,
    region,
    specificity: selectedSpecificity,
    priority: Number.isInteger(definition.priority) ? definition.priority : 0,
    objectiveVector,
    objectiveScore: objectiveScoreFor({ definition, region, context, objective }),
    rationale: rationaleFor({ definition, region, context, objective, objectiveVector })
  };
}

function compareVector({ definition, region, context, objective }) {
  const singleProviderPenalty = (context.colocated ?? []).some((resource) =>
    resource.provider && resource.provider !== definition.provider
  )
    ? 1
    : 0;
  const effectiveCost = costWithEgress(region);

  const metrics = {
    cost: metricOrMissing(effectiveCost),
    latency: metricOrMissing(region.latency),
    carbon: metricOrMissing(region.carbon),
    "single-provider": [singleProviderPenalty, 0]
  };

  if (objective === "cost") return [...metrics.cost, ...metrics.latency, singleProviderPenalty, ...metrics.carbon];
  if (objective === "latency") return [...metrics.latency, ...metrics.cost, singleProviderPenalty, ...metrics.carbon];
  if (objective === "carbon") return [...metrics.carbon, ...metrics.cost, ...metrics.latency, singleProviderPenalty];
  return [...metrics["single-provider"], ...metrics.cost, ...metrics.latency, ...metrics.carbon];
}

function costWithEgress(region) {
  if (!Number.isFinite(region.cost)) return undefined;
  return region.cost + (Number.isFinite(region.egressCost) ? region.egressCost : 0);
}

function metricOrMissing(value) {
  return Number.isFinite(value) ? [0, value] : [1, LARGE_SCORE];
}

function compareCandidates(left, right) {
  return (
    compareBeforeStableId(left, right) ||
    left.definition.id.localeCompare(right.definition.id) ||
    left.region.id.localeCompare(right.region.id)
  );
}

function compareBeforeStableId(left, right) {
  return (
    descending(left.specificity.score, right.specificity.score) ||
    compareDetail(left.specificity.detail, right.specificity.detail) ||
    descending(left.specificity.dimensionCount, right.specificity.dimensionCount) ||
    descending(left.priority, right.priority) ||
    compareObjectiveVector(left.objectiveVector, right.objectiveVector)
  );
}

function compareDetail(left, right) {
  for (const field of DETAIL_ORDER) {
    const comparison = descending(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function compareObjectiveVector(left, right) {
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? LARGE_SCORE;
    const rightValue = right[index] ?? LARGE_SCORE;
    if (leftValue < rightValue) return -1;
    if (leftValue > rightValue) return 1;
  }
  return 0;
}

function publicRank(candidate) {
  return {
    definitionId: candidate.definition.id,
    region: candidate.region.id,
    specificity: candidate.specificity.score,
    priority: candidate.priority,
    objectiveScore: candidate.objectiveScore,
    rank: candidate.rank,
    rationale: candidate.rationale
  };
}

function publicRejected(candidate) {
  return {
    definitionId: candidate.definitionId,
    reason: candidate.reason
  };
}

function objectiveScoreFor({ definition, region, context, objective }) {
  const singleProviderPenalty = (context.colocated ?? []).some((resource) =>
    resource.provider && resource.provider !== definition.provider
  )
    ? 1
    : 0;
  const egress = Number.isFinite(region.egressCost) ? region.egressCost : 0;

  if (objective === "single-provider") return singleProviderPenalty;
  if (objective === "cost" && Number.isFinite(region.cost)) return region.cost + egress;
  if (objective === "latency" && Number.isFinite(region.latency)) return region.latency;
  if (objective === "carbon" && Number.isFinite(region.carbon)) return region.carbon;

  for (const fallback of [region.latency, region.cost, region.carbon]) {
    if (Number.isFinite(fallback)) return fallback;
  }
  return LARGE_SCORE;
}

function createDeploymentPlan({
  context,
  objective,
  catalogContentHash,
  matchDecisionId,
  winner,
  rankedCandidates,
  ranking,
  rejectedCandidates,
  tie
}) {
  return {
    apiVersion: "hobo.deployment-plan/v1",
    deploymentId: context.deploymentId,
    resources: [
      {
        id: context.resourceId,
        name: context.resourceId,
        port: {
          interface: context.portInterface ?? `hobo:${context.resourceType}/default`,
          type: context.resourceType,
          className: context.resourceClass
        },
        provider: {
          id: winner.definition.provider,
          definitionId: winner.definition.id,
          driver: winner.definition.driver ?? "terraform"
        },
        context: {
          envType: context.envType,
          app: context.app,
          env: context.env,
          tenant: context.tenant,
          resourceType: context.resourceType,
          resourceClass: context.resourceClass,
          resourceId: context.resourceId
        },
        options: {
          region: winner.region.id,
          providerOptions: {
            [winner.definition.provider]: winner.definition.providerOptions ?? {}
          }
        },
        deps: [...(context.deps ?? [])],
        strategy: context.strategy ?? "reconcile",
        replication: winner.region.replication ?? "single-region",
        workloadProfile: winner.definition.workloadProfile ?? "managed-resource",
        outputs: [...(winner.definition.outputs ?? [])]
      }
    ],
    edges: [],
    meta: {
      objective,
      provenance: {
        sourceManifestHash: context.sourceManifestHash ?? "sha256:0000000000000000000000000000000000000000000000000000000000000000",
        catalogContentHash,
        matchDecisionIds: [matchDecisionId]
      },
      tie,
      rankingRationale: ranking.map((rank) => {
        const candidate = rankedByDefinitionAndRegion(rankedCandidates, rank.definitionId, rank.region);
        return {
          definitionId: rank.definitionId,
          region: rank.region,
          rank: rank.rank,
          objective,
          rationale: candidate?.rationale ?? "ranked by specificity, priority, objective, stable id"
        };
      }),
      rejectedCandidates
    }
  };
}

function rankedByDefinitionAndRegion(ranked, definitionId, region) {
  return ranked.find(
    (candidate) => candidate.definition.id === definitionId && candidate.region.id === region
  ) ?? null;
}

function rationaleFor({ definition, region, context, objective, objectiveVector }) {
  const crossProvider = (context.colocated ?? []).some((resource) =>
    resource.provider && resource.provider !== definition.provider
  );
  return [
    `objective=${objective}`,
    `region=${region.id}`,
    `provider=${definition.provider}`,
    crossProvider ? "cross-provider-egress=true" : "cross-provider-egress=false",
    `objectiveVector=${objectiveVector.join("/")}`
  ].join("; ");
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

function catalogSnapshot(catalog) {
  const snapshot = isCallable(catalog?.snapshot) ? catalog.snapshot() : catalog;
  if (!isObjectRecord(snapshot) || !Array.isArray(snapshot.definitions)) {
    throw new Error("catalog snapshot with definitions is required");
  }
  return {
    ...snapshot,
    contentHash: snapshot.contentHash ?? stableHash(snapshot.definitions)
  };
}

function assertContext(context) {
  if (!isObjectRecord(context)) {
    throw new Error("context must be an object");
  }
  for (const field of ["deploymentId", "resourceId", "resourceType", "resourceClass"]) {
    if (!isNonEmptyString(context[field])) {
      throw new Error(`context.${field} must be a non-empty string`);
    }
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

function stableHash(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortKeys(value))).digest("hex")}`;
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (!isObjectRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function descending(left, right) {
  return left > right ? -1 : left < right ? 1 : 0;
}

function isNonEmptyString(value) {
  return isString(value) && value.length > 0;
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isCallable(value) {
  return ["[object Function]", "[object AsyncFunction]", "[object GeneratorFunction]"].includes(
    Object.prototype.toString.call(value),
  );
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
