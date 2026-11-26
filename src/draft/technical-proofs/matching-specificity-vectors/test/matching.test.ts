import assert from "node:assert/strict";
import { test } from "vitest";

import {
  decideMatch,
  hashCatalog,
  specificity
} from "../src/matching.js";

const context = Object.freeze({
  resourceType: "database",
  envType: "production",
  env: "prod-us",
  app: "orders",
  tenant: "acme",
  resourceClass: "ha",
  resourceId: "orders-db"
});

test("specificity uses grouped 0..3 score plus deterministic detail", () => {
  assert.deepEqual(specificity({}), {
    score: 0,
    dimensionCount: 0,
    detail: {
      resourceId: 0,
      resourceClass: 0,
      tenant: 0,
      app: 0,
      env: 0,
      envType: 0
    }
  });

  assert.equal(specificity({ envType: "production" }).score, 1);
  assert.equal(specificity({ envType: "production", app: "orders" }).score, 2);
  assert.equal(
    specificity({ envType: "production", app: "orders", resourceClass: "ha" }).score,
    3
  );
  assert.equal(
    specificity({
      envType: "production",
      env: "prod-us",
      app: "orders",
      tenant: "acme",
      resourceClass: "ha",
      resourceId: "orders-db"
    }).score,
    3
  );
});

test("clear winner outspecifies the catch-all default", () => {
  const decision = decideMatch({
    context,
    catalog: {
      definitions: [
        definition("provider.default", {}),
        definition("prod.ha", { envType: "production", resourceClass: "ha" }),
        definition("prod.orders.db", {
          envType: "production",
          app: "orders",
          resourceClass: "ha"
        })
      ]
    }
  });

  assert.equal(decision.winnerId, "prod.orders.db");
  assert.equal(decision.tie, false);
  assert.deepEqual(decision.ranking.map((rank) => rank.id), [
    "prod.orders.db",
    "prod.ha",
    "provider.default"
  ]);
});

test("priority breaks ties only inside the same specificity boundary", () => {
  const decision = decideMatch({
    context,
    catalog: {
      definitions: [
        definition("prod.ha.default-priority", {
          envType: "production",
          resourceClass: "ha"
        }, { priority: 10 }),
        definition("prod.ha.high-priority", {
          envType: "production",
          resourceClass: "ha"
        }, { priority: 20 }),
        definition("catchall.not-allowed-to-win", {}, { priority: 1000 })
      ]
    }
  });

  assert.equal(decision.winnerId, "prod.ha.high-priority");
  assert.equal(decision.ranking.at(-1).id, "catchall.not-allowed-to-win");
});

test("true ties choose stable id, set tie flag, and include catalog hash", () => {
  const catalog = {
    definitions: [
      definition("beta", { envType: "production", resourceClass: "ha" }),
      definition("alpha", { envType: "production", resourceClass: "ha" })
    ]
  };

  const decision = decideMatch({ context, catalog });

  assert.equal(decision.winnerId, "alpha");
  assert.equal(decision.tie, true);
  assert.deepEqual(decision.tiedIds, ["alpha", "beta"]);
  assert.equal(decision.catalogHash, hashCatalog(catalog));
  assert.match(decision.planWarnings[0], /true tie/);
});

test("catalog additions can change a tied winner only with a different catalog hash", () => {
  const before = {
    definitions: [
      definition("beta", { envType: "production", resourceClass: "ha" }),
      definition("gamma", { envType: "production", resourceClass: "ha" })
    ]
  };
  const after = {
    definitions: [
      ...before.definitions,
      definition("alpha", { envType: "production", resourceClass: "ha" })
    ]
  };

  const beforeDecision = decideMatch({ context, catalog: before });
  const afterDecision = decideMatch({ context, catalog: after });

  assert.equal(beforeDecision.winnerId, "beta");
  assert.equal(afterDecision.winnerId, "alpha");
  assert.notEqual(beforeDecision.catalogHash, afterDecision.catalogHash);
  assert.equal(afterDecision.tie, true);
});

test("tenant-specific rule outranks app-wide rule before objective", () => {
  const decision = decideMatch({
    context,
    objective: "cost",
    catalog: {
      definitions: [
        definition("app-wide-cheaper", {
          envType: "production",
          app: "orders",
          resourceClass: "ha"
        }, { objectives: { cost: 1 } }),
        definition("tenant-specific", {
          envType: "production",
          tenant: "acme",
          resourceClass: "ha"
        }, { objectives: { cost: 100 } })
      ]
    }
  });

  assert.equal(decision.winnerId, "tenant-specific");
});

test("invalid and nonmatching candidates are rejected with reasons", () => {
  const decision = decideMatch({
    context,
    catalog: {
      definitions: [
        definition("valid", { envType: "production" }),
        definition("wrong-env", { envType: "ephemeral" }),
        { id: "invalid", type: "database", criteria: { region: "us-east-1" } },
        definition("wrong-type", {}, { type: "queue" })
      ]
    }
  });

  assert.equal(decision.winnerId, "valid");
  assert.match(
    decision.rejected.flatMap((entry) => entry.reasons).join("\n"),
    /unknown criteria fields: region/
  );
  assert.match(
    decision.rejected.find((entry) => entry.id === "wrong-env").reasons.join("\n"),
    /envType=ephemeral does not match production/
  );
});

function definition(id, criteria, {
  type = "database",
  priority = 0,
  objectives = { cost: 10, latency: 10, carbon: 10 }
} = {}) {
  return { id, type, criteria, priority, objectives };
}
