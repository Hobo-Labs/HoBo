import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  buildFixtureProvider,
  createDefinitionCatalog,
  defineResource,
  remediationForUnsupportedPort,
  register,
  registerProviderDefaults,
  selectFromCatalogWithControlPlaneScorer,
  validateProviderDefaults
} from "../src/provider-default-definitions.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("registering a fixture provider yields one default definition per declared capability", () => {
  const provider = buildFixtureProvider();
  const registration = registerProviderDefaults(provider);

  assert.deepEqual(
    registration.definitions.map((definition) => [definition.id, definition.type, definition.match]),
    [
      ["aws.default.database", "database", {}],
      ["aws.default.objectStore", "objectStore", {}],
      ["aws.default.compute", "compute", {}]
    ]
  );
  assert.equal(registration.errors.length, 0);
  assert.equal(registration.definitions.every((definition) => definition.source === "provider-default"), true);
});

test(".register(provider) emits defaults into the catalog consumed by Matching", () => {
  const catalog = createDefinitionCatalog();
  const registration = register(buildFixtureProvider(), catalog);

  assert.equal(registration.catalog, catalog);
  assert.deepEqual(
    catalog.definitions.map((definition) => definition.id),
    ["aws.default.database", "aws.default.objectStore", "aws.default.compute"]
  );
});

test("matching selects the provider default when no explicit override exists", () => {
  const registration = register(buildFixtureProvider(), createDefinitionCatalog());

  const decision = selectFromCatalogWithControlPlaneScorer(
    { type: "objectStore", require: ["durable"] },
    registration.catalog,
    { envType: "development", resourceId: "assets" }
  );

  assert.equal(decision.winner.id, "aws.default.objectStore");
  assert.equal(decision.winner.matchScore, 0);
  assert.equal(decision.tie, false);
});

test("explicit platform definitions naturally outscore catch-all provider defaults", () => {
  const registration = register(buildFixtureProvider(), createDefinitionCatalog());
  const explicitDefinition = defineResource({
    id: "platform.database.prod-ha",
    type: "database",
    provider: "aws",
    driver: "terraform",
    resourceClass: "rds-aurora-postgres",
    satisfies: ["postgres", "managed", "ha"],
    match: { envType: "production", resourceClass: "ha" },
    priority: 0
  });
  registration.catalog.definitions.push(explicitDefinition);

  const decision = selectFromCatalogWithControlPlaneScorer(
    { type: "database", require: ["postgres", "managed"] },
    registration.catalog,
    { envType: "production", resourceClass: "ha", resourceId: "orders-db" }
  );

  assert.equal(decision.winner.id, "platform.database.prod-ha");
  assert.equal(decision.winner.matchScore, 2);
  assert.deepEqual(
    decision.rejected.map((candidate) => candidate.id),
    ["aws.default.database"]
  );
});

test("unsupported ports produce no default and emit author-time remediation input", () => {
  const registration = registerProviderDefaults(buildFixtureProvider());

  assert.equal(registration.definitions.some((definition) => definition.type === "queue"), false);
  assert.deepEqual(remediationForUnsupportedPort("aws", "queue"), {
    provider: "aws",
    port: "queue",
    code: "provider-capability-missing",
    message: "Provider aws does not ship a default Resource Definition for queue"
  });
});

test("default definitions carry the equivalence map plus realize output", () => {
  const provider = buildFixtureProvider({
    realize: (type, equivalence) => ({
      type,
      resourceClass: equivalence.resourceClass,
      driver: equivalence.driver,
      with: { emittedBy: `realize:${type}` }
    })
  });

  const registration = registerProviderDefaults(provider);
  const database = registration.definitions.find((definition) => definition.type === "database");

  assert.equal(database.equivalence.providerResourceClass, "rds-aurora-postgres");
  assert.deepEqual(database.realization, {
    resourceClass: "rds-aurora-postgres",
    driver: "terraform",
    with: { emittedBy: "realize:database" }
  });
  assert.deepEqual(database.with, { emittedBy: "realize:database" });
});

test("providers cannot claim equivalence for a capability they do not satisfy", () => {
  const provider = buildFixtureProvider({
    equivalence: {
      queue: {
        resourceClass: "sqs",
        driver: "terraform",
        satisfies: ["durable"]
      }
    }
  });

  const validation = validateProviderDefaults(provider);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /queue.*not declared as a provider capability/);
});

test("duplicate default definitions for one port fail validation", () => {
  const provider = buildFixtureProvider({
    capabilities: [
      { type: "database", satisfies: ["postgres", "managed"] },
      { type: "database", satisfies: ["postgres", "managed", "ha"] }
    ]
  });

  const validation = validateProviderDefaults(provider);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /duplicate default Resource Definition for database/);
});

test("equivalence drift from realize output fails before registration is trusted", () => {
  const provider = buildFixtureProvider({
    realize: (type) => ({
      type,
      resourceClass: type === "database" ? "unclaimed-postgres" : undefined
    })
  });

  const validation = validateProviderDefaults(provider);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /database.*realize.*unclaimed-postgres.*equivalence.*rds-aurora-postgres/);
});

test("realize output must include class and driver before defaults are trusted", () => {
  const provider = buildFixtureProvider({
    realize: (type) => ({ type })
  });

  const validation = validateProviderDefaults(provider);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /database.*realize output missing resourceClass/);
  assert.match(validation.errors.join("\n"), /database.*realize output missing driver/);
});

test("typed declarations publish the provider-default contract surface", async () => {
  const typeDeclarations = await readFile(
    path.join(packageRoot, "src", "provider-default-definitions.d.ts"),
    "utf8"
  );

  assert.match(typeDeclarations, /export interface ProviderDefaultDefinition/);
  assert.match(typeDeclarations, /with: JsonObject/);
  assert.match(typeDeclarations, /equivalence: \{/);
  assert.match(typeDeclarations, /realization: \{/);
  assert.match(typeDeclarations, /export function createDefinitionCatalog/);
  assert.match(typeDeclarations, /export function register/);
  assert.doesNotMatch(typeDeclarations, /export type ResourceDefinition/);
});
