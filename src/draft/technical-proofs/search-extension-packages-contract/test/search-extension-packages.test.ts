import assert from "node:assert/strict";
import { test } from "vitest";

import {
  SearchExtensionContractError,
  defineEmbedCapability,
  defineGraphIndex,
  defineVectorIndex,
  eq,
  buildVectorNoEgressPlan,
  hybridRrf,
  inList,
  planSearchIndexMigration,
  runGraphTraversalStep,
  runVectorSearchStep,
  validateSearchEventFamilies,
  vectorSearchSubscription,
} from "../src/search-extension-packages.js";

const vectors = Object.freeze([
  Object.freeze({
    id: "doc-1",
    vector: Object.freeze([0.9, 0.1, 0]),
    fields: Object.freeze({ tenantId: "tenant-a", category: "runbook", visibility: "internal" }),
  }),
  Object.freeze({
    id: "doc-2",
    vector: Object.freeze([0.5, 0.5, 0]),
    fields: Object.freeze({ tenantId: "tenant-a", category: "guide", visibility: "public" }),
  }),
  Object.freeze({
    id: "doc-3",
    vector: Object.freeze([0.2, 0.8, 0]),
    fields: Object.freeze({ tenantId: "tenant-b", category: "runbook", visibility: "internal" }),
  }),
]);

test("vector extension returns cosine-ranked ids with typed filters as a step", () => {
  const index = defineVectorIndex({
    name: "docs_vector",
    field: "embedding",
    dimensions: 3,
    filterFields: ["tenantId", "category"],
  });

  const result = runVectorSearchStep({
    index,
    records: vectors,
    queryVector: [1, 0, 0],
    filter: eq("tenantId", "tenant-a"),
    limit: 2,
  });

  assert.deepEqual(
    result.hits.map((hit) => ({ id: hit.id, score: Number(hit.score.toFixed(6)) })),
    [
      { id: "doc-1", score: 0.993884 },
      { id: "doc-2", score: 0.707107 },
    ],
  );
  assert.equal(result.reactive, false);
  assert.deepEqual(result.event, {
    type: "run.StepCompleted",
    modality: "vector",
    index: "docs_vector",
    resultCount: 2,
  });
  assert.deepEqual(result.searchExtension, {
    packageName: "@hobo/vector",
    matchingDimension: "search-extension",
    witCapability: "hobo:search/vector@0.1.0",
    portability: "source-portable-only",
  });
});

test("hybrid RRF fuses full-text hits with vector-extension hits", () => {
  const result = hybridRrf({
    fullTextHits: [
      { id: "doc-2", score: 7 },
      { id: "doc-1", score: 4 },
      { id: "doc-4", score: 1 },
    ],
    extensionHits: [
      { id: "doc-1", score: 0.99 },
      { id: "doc-3", score: 0.82 },
    ],
    k: 60,
  });

  assert.equal(result.reactive, false);
  assert.deepEqual(result.event, {
    type: "run.StepCompleted",
    modality: "hybrid-rrf",
    resultCount: 4,
  });
  assert.deepEqual(result.hits.map((hit) => hit.id), ["doc-1", "doc-2", "doc-3", "doc-4"]);
});

test("embed capability realizes local no-egress path for air-gapped Camps and surfaces hosted egress", () => {
  assert.deepEqual(defineEmbedCapability({ camp: "air-gap", model: "nomic-embed-text" }), {
    capability: "hobo:embed",
    adapter: "local-model",
    model: "nomic-embed-text",
    egress: "none",
    policySignal: null,
    portabilityFloor: "pgvector + local-model",
  });

  assert.deepEqual(defineEmbedCapability({ camp: "prod", provider: "openai", model: "text-embedding-3-small" }), {
    capability: "hobo:embed",
    adapter: "hosted-api",
    provider: "openai",
    model: "text-embedding-3-small",
    egress: "third-party-text",
    policySignal: {
      type: "cost-egress",
      effect: "requires-policy-review",
      reason: "hosted embedder sends row/query text outside the Camp boundary",
    },
    portabilityFloor: "pgvector + local-model",
  });
});

test("pgvector plus local model is a complete no-egress vector path", () => {
  const index = defineVectorIndex({
    name: "docs_vector",
    field: "embedding",
    dimensions: 3,
    filterFields: ["tenantId"],
  });

  assert.deepEqual(
    buildVectorNoEgressPlan({
      index,
      embed: defineEmbedCapability({ camp: "air-gap", model: "nomic-embed-text" }),
      native: { adapter: "pgvector", provider: "postgres", engineClass: "pgvector" },
    }),
    {
      status: "complete",
      egress: "none",
      packageName: "@hobo/vector",
      searchExtension: "hobo:search/vector@0.1.0",
      nativeAdapter: "pgvector",
      embedAdapter: "local-model",
      portability: "source-portable-only",
    },
  );
});

test("vector index changes ride migration phases and embedding model changes re-embed", () => {
  const prior = defineVectorIndex({
    name: "docs_vector",
    field: "embedding",
    dimensions: 3,
    filterFields: ["tenantId"],
    embeddingModel: "nomic-embed-text:v1",
  });
  const next = defineVectorIndex({
    name: "docs_vector",
    field: "embedding",
    dimensions: 3,
    filterFields: ["tenantId", "category"],
    embeddingModel: "nomic-embed-text:v2",
  });

  assert.deepEqual(planSearchIndexMigration({ prior, next }), {
    events: [
      { type: "migration.Planned", index: "docs_vector", reason: "search index schema changed" },
      { type: "migration.PhaseApplied", phase: "expand", index: "docs_vector", addFilterFields: ["category"] },
      { type: "migration.PhaseApplied", phase: "backfill", index: "docs_vector", action: "re-embed" },
      { type: "migration.PhaseApplied", phase: "contract", index: "docs_vector", snapshotRequired: true },
      { type: "migration.Verified", index: "docs_vector" },
    ],
    reembedRequired: true,
  });
});

test("graph traversal package lowers to search extension but rejects portable predicate DSL traversal", () => {
  const index = defineGraphIndex({
    name: "docs_graph",
    nodes: ["Document", "Tag"],
    edges: ["TAGGED_AS"],
  });

  const result = runGraphTraversalStep({
    index,
    traversal: { start: "Document:doc-1", edge: "TAGGED_AS", depth: 1 },
  });

  assert.deepEqual(result.event, {
    type: "run.StepCompleted",
    modality: "graph",
    index: "docs_graph",
    resultCount: 0,
  });
  assert.equal(result.reactive, false);

  assert.throws(
    () =>
      runGraphTraversalStep({
        index,
        traversal: inList("tag", ["security"]),
      }),
    (error) => {
      assert.ok(error instanceof SearchExtensionContractError);
      assert.equal(error.code, "graph-portable-predicate-rejected");
      return true;
    },
  );
});

test("adversarial guards reject subscriptions, hosted egress opacity, invalid filters, and new event families", () => {
  const index = defineVectorIndex({
    name: "docs_vector",
    field: "embedding",
    dimensions: 3,
    filterFields: ["tenantId"],
  });

  assert.throws(
    () => vectorSearchSubscription({ index, text: "disk" }),
    /vector search is step-only and cannot be used through useSubscription/,
  );
  assert.throws(
    () =>
      runVectorSearchStep({
        index,
        records: vectors,
        queryVector: [1, 0, 0],
        filter: eq("category", "runbook"),
      }),
    /filter field is not indexed: category/,
  );
  assert.throws(
    () => defineEmbedCapability({ camp: "prod", model: "text-embedding-3-small" }),
    /hosted embedder must name its provider/,
  );
  assert.throws(
    () =>
      validateSearchEventFamilies([
        { type: "vector.SearchCompleted" },
        { type: "run.StepCompleted" },
      ]),
    /new search event family is not allowed: vector.SearchCompleted/,
  );
});
