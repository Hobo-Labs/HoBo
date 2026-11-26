import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";
const VECTOR_PACKAGE = "@hobo/vector";
const GRAPH_PACKAGE = "@hobo/graph";
const PORTABILITY_FLOOR = "pgvector + local-model";
const ALLOWED_EVENT_TYPES = new Set([
  "query.Completed",
  "data.Changed",
  "migration.Planned",
  "migration.PhaseApplied",
  "migration.Verified",
  "run.StepCompleted",
]);

export class SearchExtensionContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "SearchExtensionContractError";
    this.code = code;
    this.details = clone(details);
  }
}

export function defineVectorIndex(input) {
  assertObject(input, "vector index");
  const dimensions = assertPositiveInteger(input.dimensions, "vectorIndex.dimensions");

  return deepFreeze({
    kind: "vector",
    packageName: VECTOR_PACKAGE,
    matchingDimension: "search-extension",
    witCapability: "hobo:search/vector@0.1.0",
    name: assertResourceName(input.name, "vectorIndex.name"),
    field: assertFieldName(input.field, "vectorIndex.field"),
    dimensions,
    filterFields: normalizeFieldList(input.filterFields ?? [], "vectorIndex.filterFields"),
    embeddingModel: input.embeddingModel ? assertNonEmptyString(input.embeddingModel, "vectorIndex.embeddingModel") : null,
  });
}

export function defineGraphIndex(input) {
  assertObject(input, "graph index");

  return deepFreeze({
    kind: "graph",
    packageName: GRAPH_PACKAGE,
    matchingDimension: "search-extension",
    witCapability: "hobo:search/graph@0.1.0",
    name: assertResourceName(input.name, "graphIndex.name"),
    nodes: normalizeStringList(input.nodes, "graphIndex.nodes"),
    edges: normalizeStringList(input.edges, "graphIndex.edges"),
  });
}

export function eq(field, value) {
  return deepFreeze({ type: "eq", field: assertFieldName(field, "eq.field"), value: clone(value) });
}

export function inList(field, values) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new SearchExtensionContractError("predicate-values-required", "inList.values must be a non-empty array");
  }
  return deepFreeze({ type: "in", field: assertFieldName(field, "inList.field"), values: values.map(clone) });
}

export function runVectorSearchStep(input) {
  assertObject(input, "vector search");
  const index = assertVectorIndex(input.index);
  const queryVector = normalizeVector(input.queryVector, index.dimensions, "queryVector");
  const records = normalizeVectorRecords(input.records ?? [], index.dimensions);
  const filter = input.filter ? normalizePredicate(input.filter) : null;
  if (filter) {
    validateFilterFields(filter, index.filterFields);
  }

  const hits = records
    .filter((record) => (filter ? evaluatePredicate(filter, record.fields) : true))
    .map((record) => ({ id: record.id, score: cosineSimilarity(queryVector, record.vector) }))
    .filter((hit) => hit.score > 0)
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, input.limit ? assertPositiveInteger(input.limit, "vectorSearch.limit") : undefined);

  return deepFreeze({
    hits,
    reactive: false,
    searchExtension: {
      packageName: VECTOR_PACKAGE,
      matchingDimension: "search-extension",
      witCapability: index.witCapability,
      portability: "source-portable-only",
    },
    event: {
      type: "run.StepCompleted",
      modality: "vector",
      index: index.name,
      resultCount: hits.length,
    },
  });
}

export function hybridRrf({ fullTextHits, extensionHits, k = 60 } = {}) {
  const ranked = new Map();
  accumulateRrf(ranked, normalizeHits(fullTextHits, "fullTextHits"), Number(k));
  accumulateRrf(ranked, normalizeHits(extensionHits, "extensionHits"), Number(k));
  const hits = [...ranked.values()].sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));

  return deepFreeze({
    hits,
    reactive: false,
    event: {
      type: "run.StepCompleted",
      modality: "hybrid-rrf",
      resultCount: hits.length,
    },
  });
}

export function defineEmbedCapability(input) {
  assertObject(input, "embed capability");
  const camp = assertNonEmptyString(input.camp, "embed.camp");
  const model = assertNonEmptyString(input.model, "embed.model");

  if (camp === "dev" || camp === "air-gap") {
    return deepFreeze({
      capability: "hobo:embed",
      adapter: "local-model",
      model,
      egress: "none",
      policySignal: null,
      portabilityFloor: PORTABILITY_FLOOR,
    });
  }

  const provider = assertNonEmptyString(input.provider, "hosted embedder must name its provider");
  return deepFreeze({
    capability: "hobo:embed",
    adapter: "hosted-api",
    provider,
    model,
    egress: "third-party-text",
    policySignal: {
      type: "cost-egress",
      effect: "requires-policy-review",
      reason: "hosted embedder sends row/query text outside the Camp boundary",
    },
    portabilityFloor: PORTABILITY_FLOOR,
  });
}

export function buildVectorNoEgressPlan({ index, embed, native } = {}) {
  const vectorIndex = assertVectorIndex(index);
  assertObject(embed, "embed capability");
  assertObject(native, "vector native");

  if (embed.adapter !== "local-model" || embed.egress !== "none") {
    throw new SearchExtensionContractError("no-egress-embed-required", "vector no-egress path requires local-model embed");
  }
  if (native.adapter !== "pgvector") {
    throw new SearchExtensionContractError("no-egress-native-required", "vector no-egress path requires pgvector native");
  }

  return deepFreeze({
    status: "complete",
    egress: "none",
    packageName: VECTOR_PACKAGE,
    searchExtension: vectorIndex.witCapability,
    nativeAdapter: "pgvector",
    embedAdapter: "local-model",
    portability: "source-portable-only",
  });
}

export function planSearchIndexMigration({ prior, next } = {}) {
  const before = assertVectorIndex(prior);
  const after = assertVectorIndex(next);
  if (before.name !== after.name) {
    throw new SearchExtensionContractError("index-name-mismatch", "migration requires the same index name");
  }

  const addFilterFields = after.filterFields.filter((field) => !before.filterFields.includes(field));
  const reembedRequired = before.embeddingModel !== after.embeddingModel;
  const events = [
    { type: "migration.Planned", index: after.name, reason: "search index schema changed" },
  ];

  if (addFilterFields.length > 0) {
    events.push({ type: "migration.PhaseApplied", phase: "expand", index: after.name, addFilterFields });
  }
  if (reembedRequired) {
    events.push({ type: "migration.PhaseApplied", phase: "backfill", index: after.name, action: "re-embed" });
  }
  events.push(
    { type: "migration.PhaseApplied", phase: "contract", index: after.name, snapshotRequired: true },
    { type: "migration.Verified", index: after.name },
  );

  return deepFreeze({ events, reembedRequired });
}

export function runGraphTraversalStep(input) {
  assertObject(input, "graph traversal");
  const index = assertGraphIndex(input.index);
  const traversal = input.traversal;
  assertObject(traversal, "graph traversal query");

  if (["eq", "in", "range", "and"].includes(traversal.type)) {
    throw new SearchExtensionContractError(
      "graph-portable-predicate-rejected",
      "graph traversal is not part of the portable predicate DSL",
    );
  }

  assertNonEmptyString(traversal.start, "graphTraversal.start");
  assertNonEmptyString(traversal.edge, "graphTraversal.edge");
  assertPositiveInteger(traversal.depth, "graphTraversal.depth");

  return deepFreeze({
    hits: [],
    reactive: false,
    searchExtension: {
      packageName: GRAPH_PACKAGE,
      matchingDimension: "search-extension",
      witCapability: index.witCapability,
      portability: "source-portable-only",
    },
    event: {
      type: "run.StepCompleted",
      modality: "graph",
      index: index.name,
      resultCount: 0,
    },
  });
}

export function vectorSearchSubscription() {
  throw new SearchExtensionContractError(
    "vector-subscription-rejected",
    "vector search is step-only and cannot be used through useSubscription",
  );
}

export function validateSearchEventFamilies(events) {
  if (!Array.isArray(events)) {
    throw new SearchExtensionContractError("events-array-required", "events must be an array");
  }

  for (const event of events) {
    assertObject(event, "event");
    const type = assertNonEmptyString(event.type, "event.type");
    if (!ALLOWED_EVENT_TYPES.has(type)) {
      throw new SearchExtensionContractError(
        "new-search-event-family-rejected",
        `new search event family is not allowed: ${type}`,
      );
    }
  }

  return deepFreeze({ status: "accepted", count: events.length });
}

function assertVectorIndex(index) {
  assertObject(index, "vector index");
  if (index.kind !== "vector") {
    throw new SearchExtensionContractError("vector-index-required", "vector search requires a vector index");
  }
  return index;
}

function assertGraphIndex(index) {
  assertObject(index, "graph index");
  if (index.kind !== "graph") {
    throw new SearchExtensionContractError("graph-index-required", "graph traversal requires a graph index");
  }
  return index;
}

function normalizeVectorRecords(records, dimensions) {
  if (!Array.isArray(records)) {
    throw new SearchExtensionContractError("records-array-required", "records must be an array");
  }

  return records.map((record) => {
    assertObject(record, "vector record");
    assertObject(record.fields, "vector record fields");
    return {
      id: assertNonEmptyString(record.id, "record.id"),
      vector: normalizeVector(record.vector, dimensions, "record.vector"),
      fields: clone(record.fields),
    };
  });
}

function normalizeVector(vector, dimensions, label) {
  if (!Array.isArray(vector) || vector.length !== dimensions || vector.some((value) => !isJsonNumber(value))) {
    throw new SearchExtensionContractError(
      "vector-dimension-invalid",
      `${label} must contain ${dimensions} numeric dimensions`,
    );
  }
  return vector;
}

function normalizePredicate(predicate) {
  assertObject(predicate, "predicate");
  if (!["eq", "in"].includes(predicate.type)) {
    throw new SearchExtensionContractError("predicate-invalid", "predicate must be eq or in");
  }
  return clone(predicate);
}

function evaluatePredicate(predicate, fields) {
  if (predicate.type === "eq") {
    return fields[predicate.field] === predicate.value;
  }
  if (predicate.type === "in") {
    return predicate.values.includes(fields[predicate.field]);
  }
  return false;
}

function validateFilterFields(predicate, filterFields) {
  for (const field of predicate.type === "in" || predicate.type === "eq" ? [predicate.field] : []) {
    if (!filterFields.includes(field)) {
      throw new SearchExtensionContractError("filter-field-unindexed", `filter field is not indexed: ${field}`);
    }
  }
}

function cosineSimilarity(left, right) {
  const dot = left.reduce((sum, value, index) => sum + value * right[index], 0);
  const leftMagnitude = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightMagnitude = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  if (leftMagnitude === 0 || rightMagnitude === 0) {
    return 0;
  }
  return dot / (leftMagnitude * rightMagnitude);
}

function normalizeHits(hits, label) {
  if (!Array.isArray(hits)) {
    throw new SearchExtensionContractError("hits-array-required", `${label} must be an array`);
  }
  return hits.map((hit) => {
    assertObject(hit, label);
    return {
      id: assertNonEmptyString(hit.id, `${label}.id`),
      score: Number(hit.score ?? 0),
    };
  });
}

function accumulateRrf(ranked, hits, k) {
  hits.forEach((hit, index) => {
    const rankScore = 1 / (k + index + 1);
    const prior = ranked.get(hit.id) ?? { id: hit.id, score: 0 };
    prior.score += rankScore;
    ranked.set(hit.id, prior);
  });
}

function normalizeFieldList(values, field) {
  return normalizeStringList(values, field).sort();
}

function normalizeStringList(values, field) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new SearchExtensionContractError("string-list-required", `${field} must be a non-empty array`);
  }
  return [...new Set(values.map((value) => assertNonEmptyString(value, field)))].sort();
}

function assertObject(value, field) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new SearchExtensionContractError("object-required", `${field} must be an object`);
  }
  return value;
}

function assertNonEmptyString(value, field) {
  if (!isJsonString(value) || value.trim() === "") {
    throw new SearchExtensionContractError("string-required", `${field} must be a non-empty string`);
  }
  return value;
}

function assertResourceName(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[a-z][a-z0-9_]*$/.test(text)) {
    throw new SearchExtensionContractError("resource-name-invalid", `${field} must be a lower-case resource name`);
  }
  return text;
}

function assertFieldName(value, field) {
  const text = assertNonEmptyString(value, field);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(text)) {
    throw new SearchExtensionContractError("field-name-invalid", `${field} must be an identifier`);
  }
  return text;
}

function assertPositiveInteger(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new SearchExtensionContractError("positive-integer-required", `${field} must be a positive safe integer`);
  }
  return value;
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(deepFreeze));
  }
  if (value && isJsonObject(value)) {
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, deepFreeze(nested)])));
  }
  return value;
}

function clone(value) {
  if (value === undefined) {
    return undefined;
  }
  return structuredClone instanceof Function ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
