import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "vitest";

import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  decideResourceDefinition,
  matchingDecisionToEvent,
  rankingSummary
} from "../src/matching-engine.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const declarationsUrl = new URL("../src/matching-engine.d.mts", import.meta.url);
const tscPath = fileURLToPath(
  new URL("../../../../../node_modules/typescript/bin/tsc", import.meta.url)
);

const context = Object.freeze({
  resourceType: "database",
  envType: "production",
  env: "prod-us",
  app: "orders",
  tenant: "acme",
  resourceClass: "ha",
  resourceId: "orders-db"
});

test("declarations expose the matching engine boundary and compile for consumers", async () => {
  const declarations = await readFile(declarationsUrl, "utf8");

  assert.match(declarations, /export type MatchingDecision/);
  assert.match(declarations, /export declare function decideResourceDefinition/);
  assert.match(declarations, /export declare function matchingDecisionToEvent/);
  assert.match(declarations, /objectiveScore: 0/);

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

test("selects the documented winner and emits a valid match.Decided event", () => {
  const catalog = createCatalog([
    definition("provider.default", {}),
    definition("prod.ha", { envType: "production", resourceClass: "ha" }),
    definition("prod.orders.db", {
      envType: "production",
      app: "orders",
      resourceClass: "ha"
    })
  ]);

  const decision = decideResourceDefinition({ catalog, context });
  const event = matchingDecisionToEvent(decision, {
    id: "evt-match-orders-db",
    seq: 10,
    causationId: "deployment.Planned:orders"
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "prod.orders.db");
  assert.deepEqual(rankingSummary(decision), ["prod.orders.db", "prod.ha", "provider.default"]);
  assert.equal(decision.rejectedCandidates.length, 0);
  assert.equal(decision.catalogContentHash, `sha256:${catalog.contentHash()}`);
  assert.equal(validateControlPlaneEvent(event).ok, true);
  assert.equal(event.data.winner, "prod.orders.db");
  assert.equal(event.data.tie, false);
});

test("records criteria rejections and fails closed when every candidate filters out", () => {
  const catalog = createCatalog([
    definition("staging-only", { envType: "staging" }),
    definition("wrong-class", { envType: "production", resourceClass: "cheap" })
  ]);

  const decision = decideResourceDefinition({ catalog, context });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "no matching ResourceDefinition for database");
  assert.deepEqual(
    decision.rejectedCandidates.map((candidate) => candidate.definitionId),
    ["staging-only", "wrong-class"]
  );
  assert.match(decision.rejectedCandidates[0].reason, /envType=staging/);
  assert.match(decision.rejectedCandidates[1].reason, /resourceClass=cheap/);
  assert.throws(() => matchingDecisionToEvent(decision), /cannot emit match.Decided/);
});

test("returns a precise fail-closed reason when the catalog has no definitions of the type", () => {
  const catalog = createCatalog([
    {
      id: "queue.default",
      type: "queue",
      provider: "aws",
      driver: "terraform",
      match: {}
    }
  ]);

  const decision = decideResourceDefinition({ catalog, context });

  assert.equal(decision.ok, false);
  assert.equal(decision.reason, "no ResourceDefinition candidates for database");
  assert.deepEqual(decision.ranking, []);
  assert.deepEqual(decision.rejectedCandidates, []);
});

test("true ties pick the stable definition id and flag the tie", () => {
  const catalog = createCatalog([
    definition("beta", { envType: "production", resourceClass: "ha" }),
    definition("alpha", { envType: "production", resourceClass: "ha" })
  ]);

  const decision = decideResourceDefinition({ catalog, context });
  const event = matchingDecisionToEvent(decision);

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "alpha");
  assert.equal(decision.tie, true);
  assert.deepEqual(decision.tiedDefinitionIds, ["alpha", "beta"]);
  assert.match(decision.planWarnings[0], /true tie/);
  assert.equal(event.data.tie, true);
});

test("catalog hash changes make tied winner changes attributable", () => {
  const before = createCatalog([
    definition("beta", { envType: "production", resourceClass: "ha" }),
    definition("gamma", { envType: "production", resourceClass: "ha" })
  ]);
  const after = createCatalog([
    definition("beta", { envType: "production", resourceClass: "ha" }),
    definition("gamma", { envType: "production", resourceClass: "ha" }),
    definition("alpha", { envType: "production", resourceClass: "ha" })
  ]);

  const beforeDecision = decideResourceDefinition({ catalog: before, context });
  const afterDecision = decideResourceDefinition({ catalog: after, context });

  assert.equal(beforeDecision.winner.id, "beta");
  assert.equal(afterDecision.winner.id, "alpha");
  assert.notEqual(beforeDecision.catalogContentHash, afterDecision.catalogContentHash);
  assert.equal(afterDecision.tie, true);
});

test("unsupported objectives fail before emitting an invalid match.Decided event", () => {
  const catalog = createCatalog([definition("provider.default", {})]);

  assert.throws(
    () => decideResourceDefinition({ catalog, context, objective: "random" }),
    /objective must be one of/
  );
});

function createCatalog(definitions) {
  const catalog = createResourceCatalog({ id: "platform-defaults" });
  for (const resourceDefinition of definitions) {
    catalog.register(resourceDefinition);
  }
  return catalog;
}

function definition(id, match, overrides = {}) {
  return {
    id,
    type: "database",
    engine: "postgres",
    provider: overrides.provider ?? "aws",
    driver: "terraform",
    match,
    priority: overrides.priority ?? 0,
    with: overrides.with ?? {}
  };
}
