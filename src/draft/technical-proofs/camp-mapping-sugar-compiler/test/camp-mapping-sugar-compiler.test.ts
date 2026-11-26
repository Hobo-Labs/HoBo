import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import {
  createResourceCatalog,
  defineResource
} from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import {
  decideResourceDefinition,
  rankingSummary
} from "../../matching-engine-skeleton-contract/src/matching-engine.js";
import {
  compileCampMapping,
  registerCompiledDefinitions
} from "../src/camp-mapping-sugar-compiler.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const declarationsUrl = new URL("../src/camp-mapping-sugar-compiler.d.mts", import.meta.url);
const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url)
);

const fixtureResources = Object.freeze([
  { id: "shop.db", type: "database", engine: "postgres", serviceModel: "saas" },
  { id: "shop.api", type: "compute", serviceModel: "paas" },
  { id: "shop.web", type: "web", engine: "static", serviceModel: "edge" }
]);

test("camp defaultProvider, tiers, and bindings compile to Resource Definitions consumed by Matching", () => {
  const compiled = compileCampMapping({
    campId: "prod",
    resources: fixtureResources,
    mapping: {
      defaultProvider: provider("azure", { region: "eastus" }),
      tiers: {
        saas: provider("neon", { plan: "serverless" }),
        edge: provider("cloudflare", { service: "workers" })
      },
      bindings: {
        "shop.db": provider("azure", { consistency: "session" }, { engine: "cosmos" })
      }
    }
  });

  assert.equal(compiled.apiVersion, "hobo.camp-mapping-sugar/v1");
  assert.equal(compiled.definitions.length, 6);
  assertDefinition(compiled, "camp.prod.default.database.postgres", {
    provider: "azure",
    type: "database",
    engine: "postgres",
    match: {}
  });
  assertDefinition(compiled, "camp.prod.default.compute", {
    provider: "azure",
    type: "compute",
    match: {}
  });
  assertDefinition(compiled, "camp.prod.tier.saas.database.postgres", {
    provider: "neon",
    type: "database",
    engine: "postgres",
    match: { resourceClass: "saas" }
  });
  assertDefinition(compiled, "camp.prod.tier.edge.web.static", {
    provider: "cloudflare",
    type: "web",
    engine: "static",
    match: { resourceClass: "edge" }
  });
  assertDefinition(compiled, "camp.prod.binding.shop-db", {
    provider: "azure",
    type: "database",
    engine: "cosmos",
    match: { resourceId: "shop.db" }
  });

  const catalog = createResourceCatalog({ id: "prod-camp" });
  registerCompiledDefinitions(catalog, compiled);

  const databaseDecision = decideResourceDefinition({
    catalog,
    context: { resourceType: "database", resourceId: "shop.db", resourceClass: "saas" }
  });
  assert.equal(databaseDecision.ok, true);
  assert.deepEqual(rankingSummary(databaseDecision), [
    "camp.prod.binding.shop-db",
    "camp.prod.tier.saas.database.postgres",
    "camp.prod.default.database.postgres"
  ]);

  const webDecision = decideResourceDefinition({
    catalog,
    context: { resourceType: "web", resourceId: "shop.web", resourceClass: "edge" }
  });
  assert.equal(webDecision.ok, true);
  assert.equal(webDecision.winner.id, "camp.prod.tier.edge.web.static");

  const computeDecision = decideResourceDefinition({
    catalog,
    context: { resourceType: "compute", resourceId: "shop.api", resourceClass: "paas" }
  });
  assert.equal(computeDecision.ok, true);
  assert.equal(computeDecision.winner.id, "camp.prod.default.compute");
});

test("explicit platform definition beats a compiled catch-all default through specificity only", () => {
  const catalog = createResourceCatalog({ id: "prod-explicit" });
  registerCompiledDefinitions(
    catalog,
    compileCampMapping({
      campId: "prod",
      resources: [{ id: "orders.db", type: "database", engine: "postgres", serviceModel: "saas" }],
      mapping: { defaultProvider: provider("azure") }
    })
  );
  catalog.register(
    defineResource({
      id: "platform.database.production-ha",
      type: "database",
      provider: "aws",
      driver: "terraform",
      with: { sku: "aurora" },
      match: { envType: "production", resourceClass: "ha" }
    })
  );

  const decision = decideResourceDefinition({
    catalog,
    context: {
      resourceType: "database",
      resourceId: "orders.db",
      envType: "production",
      resourceClass: "ha"
    }
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "platform.database.production-ha");
  assert.deepEqual(rankingSummary(decision), [
    "platform.database.production-ha",
    "camp.prod.default.database.postgres"
  ]);
});

test("binding ids that no declared resource uses fail closed", () => {
  assert.throws(
    () =>
      compileCampMapping({
        campId: "prod",
        resources: fixtureResources,
        mapping: {
          bindings: {
            "missing.db": provider("azure", { consistency: "session" })
          }
        }
      }),
    /binding missing\.db does not match a declared resource/
  );
});

test("provider targets cannot change the abstract resource type selected by Matching", () => {
  const compiled = compileCampMapping({
    campId: "prod",
    resources: [{ id: "shop.db", type: "database", engine: "postgres", serviceModel: "saas" }],
    mapping: {
      bindings: {
        "shop.db": provider("azure", {}, { type: "queue", engine: "cosmos" })
      }
    }
  });

  assertDefinition(compiled, "camp.prod.binding.shop-db", {
    type: "database",
    engine: "cosmos",
    match: { resourceId: "shop.db" }
  });
});

test("tier entries for absent service models fail closed", () => {
  assert.throws(
    () =>
      compileCampMapping({
        campId: "prod",
        resources: fixtureResources,
        mapping: {
          tiers: {
            batch: provider("aws", { service: "batch" })
          }
        }
      }),
    /tier batch does not match any declared resource service model/
  );
});

test("case-folded tier collisions fail before ambiguous compiled definitions reach the catalog", () => {
  assert.throws(
    () =>
      compileCampMapping({
        campId: "prod",
        resources: [{ id: "shop.db", type: "database", engine: "postgres", serviceModel: "saas" }],
        mapping: {
          tiers: {
            SaaS: provider("azure"),
            saas: provider("aws")
          }
        }
      }),
    /compiled definition collision: tier SaaS and tier saas both lower to service model saas/
  );
});

test("typed declarations publish the compiler boundary and compile for consumers", async () => {
  const declarations = await readFile(declarationsUrl, "utf8");

  assert.match(declarations, /export type CampMapping/);
  assert.match(declarations, /export type CompiledCampMapping/);
  assert.match(declarations, /export declare function compileCampMapping/);
  assert.match(declarations, /export declare function registerCompiledDefinitions/);

  const result = spawnSync(process.execPath, [tscPath, "--noEmit", "--project", "tsconfig.json"], {
    cwd: packageRoot,
    encoding: "utf8",
    shell: false
  });

  assert.equal(
    result.status,
    0,
    [result.error?.message, result.stdout, result.stderr].filter(Boolean).join("\n") ||
      "TypeScript exited non-zero"
  );
});

function provider(providerId, withOptions = {}, overrides = {}) {
  return {
    provider: providerId,
    driver: "terraform",
    with: withOptions,
    ...overrides
  };
}

function assertDefinition(compiled, id, expected) {
  const definition = compiled.definitions.find((candidate) => candidate.id === id);
  assert.ok(definition, `missing ${id}`);
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(definition[key], value, `${id}.${key}`);
  }
}
