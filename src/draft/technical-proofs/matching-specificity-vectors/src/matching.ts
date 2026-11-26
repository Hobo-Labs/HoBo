import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const MATCHING_DECISION_VERSION = "matching.specificity/v1";

export const CRITERION_FIELDS = Object.freeze([
  "envType",
  "env",
  "app",
  "tenant",
  "resourceClass",
  "resourceId"
]);

const DETAIL_ORDER = Object.freeze([
  "resourceId",
  "resourceClass",
  "tenant",
  "app",
  "env",
  "envType"
]);

const SPECIFICITY_GROUPS = Object.freeze([
  ["envType", "env"],
  ["app", "tenant"],
  ["resourceClass", "resourceId"]
]);

const MINIMIZE_OBJECTIVES = new Set(["cost", "latency", "carbon"]);

export function decideMatch({ catalog, context, objective = "cost" }) {
  assertContext(context);
  const definitions = catalog?.definitions ?? [];
  if (!Array.isArray(definitions)) {
    throw new Error("catalog.definitions must be an array");
  }

  const catalogHash = hashCatalog(catalog);
  const rejected = [];
  const candidates = [];

  for (const definition of definitions) {
    const validationErrors = validateDefinition(definition);
    if (validationErrors.length > 0) {
      rejected.push({
        id: definition?.id ?? "<unknown>",
        reasons: validationErrors
      });
      continue;
    }

    if (definition.type !== context.resourceType) {
      rejected.push({
        id: definition.id,
        reasons: [`type ${definition.type} does not match ${context.resourceType}`]
      });
      continue;
    }

    const mismatch = criterionMismatch(definition.criteria ?? {}, context);
    if (mismatch.length > 0) {
      rejected.push({ id: definition.id, reasons: mismatch });
      continue;
    }

    candidates.push(rankCandidate(definition, objective));
  }

  const ranking = candidates.sort(compareRankedCandidates);
  const winner = ranking[0] ?? null;
  const tiedIds = winner
    ? ranking
        .filter((candidate) => comparePreStable(candidate, winner) === 0)
        .map((candidate) => candidate.id)
    : [];

  return {
    schema: MATCHING_DECISION_VERSION,
    objective,
    catalogHash,
    winnerId: winner?.id ?? null,
    tie: tiedIds.length > 1,
    tiedIds,
    planWarnings: tiedIds.length > 1
      ? [`true tie between ${tiedIds.join(", ")}; add priority to disambiguate`]
      : [],
    ranking: ranking.map(publicRank),
    rejected
  };
}

export function hashCatalog(catalog) {
  return `sha256:${createHash("sha256").update(canonicalJson(catalog)).digest("hex")}`;
}

export function specificity(criteria = {}) {
  const unknownFields = Object.keys(criteria).filter((field) => !CRITERION_FIELDS.includes(field));
  if (unknownFields.length > 0) {
    throw new Error(`unknown criteria fields: ${unknownFields.sort().join(", ")}`);
  }

  const score = SPECIFICITY_GROUPS.filter((group) =>
    group.some((field) => criteria[field] !== undefined)
  ).length;
  const detail = Object.fromEntries(
    DETAIL_ORDER.map((field) => [field, criteria[field] !== undefined ? 1 : 0])
  );
  const dimensionCount = Object.values(detail).reduce((sum, value) => sum + value, 0);

  return { score, detail, dimensionCount };
}

function rankCandidate(definition, objective) {
  const candidateSpecificity = specificity(definition.criteria ?? {});
  return {
    id: definition.id,
    priority: Number.isInteger(definition.priority) ? definition.priority : 0,
    objective,
    objectiveRank: objectiveRank(definition.objectives?.[objective], objective),
    specificity: candidateSpecificity
  };
}

function compareRankedCandidates(left, right) {
  return (
    comparePreStable(left, right) ||
    left.id.localeCompare(right.id)
  );
}

function comparePreStable(left, right) {
  return (
    descending(left.specificity.score, right.specificity.score) ||
    compareDetail(left.specificity.detail, right.specificity.detail) ||
    descending(left.specificity.dimensionCount, right.specificity.dimensionCount) ||
    descending(left.priority, right.priority) ||
    ascending(left.objectiveRank, right.objectiveRank)
  );
}

function compareDetail(left, right) {
  for (const field of DETAIL_ORDER) {
    const comparison = descending(left[field], right[field]);
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function objectiveRank(value, objective) {
  if (objective === "single-provider") {
    return value === true ? 0 : 1;
  }
  if (objective === "maximize-credits") {
    return Number.isFinite(value) ? -value : Number.POSITIVE_INFINITY;
  }
  if (MINIMIZE_OBJECTIVES.has(objective)) {
    return Number.isFinite(value) ? value : Number.POSITIVE_INFINITY;
  }
  throw new Error(`unknown objective ${objective}`);
}

function validateDefinition(definition) {
  const errors = [];
  if (!definition || !isJsonObject(definition) || Array.isArray(definition)) {
    return ["definition must be an object"];
  }
  if (!isNonEmptyString(definition.id)) {
    errors.push("definition.id must be a non-empty string");
  }
  if (!isNonEmptyString(definition.type)) {
    errors.push("definition.type must be a non-empty string");
  }
  try {
    specificity(definition.criteria ?? {});
  } catch (error) {
    errors.push(error.message);
  }
  return errors;
}

function criterionMismatch(criteria, context) {
  const reasons = [];
  for (const field of Object.keys(criteria)) {
    if (!CRITERION_FIELDS.includes(field)) {
      reasons.push(`unknown criteria field ${field}`);
    } else if (criteria[field] !== context[field]) {
      reasons.push(`${field}=${String(criteria[field])} does not match ${String(context[field])}`);
    }
  }
  return reasons;
}

function assertContext(context) {
  if (!context || !isJsonObject(context) || Array.isArray(context)) {
    throw new Error("context must be an object");
  }
  if (!isNonEmptyString(context.resourceType)) {
    throw new Error("context.resourceType must be a non-empty string");
  }
}

function publicRank(candidate) {
  return {
    id: candidate.id,
    specificityScore: candidate.specificity.score,
    specificityDetail: candidate.specificity.detail,
    dimensionCount: candidate.specificity.dimensionCount,
    priority: candidate.priority,
    objectiveRank: candidate.objectiveRank
  };
}

function ascending(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function descending(left, right) {
  return left > right ? -1 : left < right ? 1 : 0;
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function isNonEmptyString(value) {
  return isJsonString(value) && value.trim().length > 0;
}
