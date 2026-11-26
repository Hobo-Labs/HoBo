import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  createResourceCatalog,
  defineResource,
  driverContractFor
} from "../src/resource-definition-driver-contract.js";

test("interfaces publish the ResourceDefinition and Driver contract shapes", () => {
  const declarations = readFileSync(
    new URL("../src/resource-definition-driver-contract.d.ts", import.meta.url),
    "utf8"
  );

  assert.match(declarations, /export type ResourceDefinition/);
  assert.match(declarations, /export interface Driver/);
  assert.match(declarations, /export type ResourceDefinitionInput/);
  assert.match(declarations, /export type CatalogSnapshot/);
  assert.match(declarations, /export type CatalogAmbiguity/);
  assert.match(declarations, /provision\(input: DriverProvisionInput\)/);
  assert.match(declarations, /destroy\(input: \{ context: MatchContext; state: JsonValue \}\)/);
  assert.match(declarations, /refresh\?\(input: \{ context: MatchContext; state: JsonValue \}\)/);
});

test("stub in-memory definition registers and is retrievable by resource type", () => {
  const catalog = createResourceCatalog({ id: "platform-defaults" });

  catalog.register({
    id: "aws.postgres.production",
    type: "database",
    engine: "postgres",
    className: "ha",
    provider: "aws",
    driver: "terraform",
    with: { instanceClass: "db.r6g.large", multiAz: true },
    match: { envType: "production", resourceClass: "ha" },
    coProvisioned: [{ type: "iam-policy", reason: "binding-output" }]
  });

  const [definition] = catalog.definitionsForType("database");

  assert.equal(definition.provider, "aws");
  assert.equal(definition.driver, "terraform");
  assert.equal(definition.match.envType, "production");
  assert.deepEqual(definition.coProvisioned, [{ type: "iam-policy", reason: "binding-output" }]);
});

test("documented class alias and provider refs normalize to the public ResourceDefinition", () => {
  const definition = defineResource({
    id: "aws.postgres.ha",
    type: "database",
    engine: "postgres",
    class: "ha",
    provider: { id: "aws" },
    driver: "terraform",
    match: { resourceClass: "ha" }
  });

  assert.equal(definition.provider, "aws");
  assert.equal(definition.className, "ha");
});

test("catalog content hash is stable and changes when definitions are added or renamed", () => {
  const first = createResourceCatalog({ id: "platform-defaults" });
  const second = createResourceCatalog({ id: "platform-defaults" });

  const database = {
    id: "aws.postgres.production",
    type: "database",
    engine: "postgres",
    provider: "aws",
    driver: "terraform",
    with: { instanceClass: "db.r6g.large" },
    match: { envType: "production" }
  };
  const bucket = {
    id: "aws.object-store.default",
    type: "objectStore",
    provider: "aws",
    driver: "terraform",
    with: { storageClass: "standard" },
    match: {}
  };

  first.register(database);
  first.register(bucket);
  second.register(bucket);
  second.register(database);

  assert.equal(first.contentHash(), second.contentHash());
  assert.equal(first.snapshot().contentHash, first.contentHash());

  const before = first.contentHash();
  first.register({ ...bucket, id: "aws.object-store.renamed" });

  assert.notEqual(first.contentHash(), before);
});

test("provider register imports shipped default definitions under the provider id", () => {
  const catalog = createResourceCatalog({ id: "provider-defaults" });

  catalog.register({
    id: "azure",
    defaultDefinitions: [
      {
        id: "default.queue",
        type: "queue",
        provider: "malicious-shadow-provider",
        driver: "terraform",
        with: { sku: "standard" },
        match: {}
      }
    ]
  });

  const [definition] = catalog.definitionsForType("queue");

  assert.equal(definition.provider, "azure");
  assert.equal(definition.id, "default.queue");
});

test("projection-sink definitions validate with paradigm and mapping", () => {
  const definition = defineResource({
    id: "aws.tickets.projection-sink.production",
    type: "projection-sink",
    paradigm: "relational",
    provider: "aws",
    driver: "terraform",
    mapping: "./projections/tickets.mapping",
    with: { tableName: "tickets_projection" },
    match: { envType: "production", resourceId: "tickets" }
  });

  assert.equal(definition.type, "projection-sink");
  assert.equal(definition.paradigm, "relational");
  assert.equal(definition.mapping, "./projections/tickets.mapping");
});

test("projection-sink mapping fails closed when empty or malformed", () => {
  for (const mapping of ["", "   ", null, []]) {
    assert.throws(
      () =>
        defineResource({
          id: "bad.projection-sink",
          type: "projection-sink",
          paradigm: "relational",
          provider: "aws",
          driver: "terraform",
          mapping,
          match: {}
        }),
      /non-empty mapping/
    );
  }
});

test("catalog ambiguity is surfaced without blocking deterministic matching", () => {
  const catalog = createResourceCatalog();
  catalog.register({
    id: "aws.postgres.default",
    type: "database",
    engine: "postgres",
    provider: "aws",
    driver: "terraform",
    match: {}
  });
  catalog.register({
    id: "azure.postgres.default",
    type: "database",
    engine: "postgres",
    provider: "azure",
    driver: "terraform",
    match: {}
  });

  assert.deepEqual(catalog.ambiguities(), [
    {
      key: "{\"engine\":\"postgres\",\"match\":{},\"type\":\"database\"}",
      definitionIds: ["aws.postgres.default", "azure.postgres.default"],
      reason: "same resource shape and match criteria; Matching must resolve by priority/objective/tiebreak"
    }
  ]);
  assert.deepEqual(catalog.snapshot().ambiguities, catalog.ambiguities());
});

test("unknown driver ids fail before a definition can enter the catalog", () => {
  assert.throws(
    () =>
      defineResource({
        id: "aws.postgres.bad",
        type: "database",
        engine: "postgres",
        provider: "aws",
        driver: "cloudformation",
        match: {}
      }),
    /unknown driver id cloudformation/
  );
});

test("echo driver is read-only by default without shipping a driver implementation", () => {
  const definition = defineResource({
    id: "external.redis.preview",
    type: "cache",
    engine: "redis",
    provider: "byo",
    driver: "echo",
    with: { outputs: { url: "redis://example.internal:6379" } },
    match: { envType: "ephemeral" }
  });

  assert.equal(definition.mutability, undefined);
  assert.deepEqual(driverContractFor(definition.driver), {
    id: "echo",
    mutability: "read-only"
  });
});
