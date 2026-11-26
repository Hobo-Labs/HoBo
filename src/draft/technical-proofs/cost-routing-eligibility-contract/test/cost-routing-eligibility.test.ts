import assert from "node:assert/strict";
import { test } from "vitest";

import {
  assertNoSingleWriterCostRoutes,
  evaluateCostRoutingPlan,
} from "../src/cost-routing-eligibility.js";

test("can-deploy refuses cost routing when a route reaches single-writer state", () => {
  const result = evaluateCostRoutingPlan({
    domain: "shop.example",
    routes: [
      costRoute("checkout-write", "/checkout/*", "prod-us", ["checkout-api"]),
    ],
    resources: [
      resource("checkout-api", "active-active-eventual", ["orders-ledger"]),
      resource("orders-ledger", "single-writer"),
    ],
    camps: [camp("prod-us", 10), camp("prod-eu", 4)],
  });

  assert.equal(result.canDeploy.allowed, false);
  assert.deepEqual(result.canDeploy.violations, [
    {
      routeId: "checkout-write",
      reason: "cost routing reaches single-writer resources: orders-ledger",
      singleWriterResourceIds: ["orders-ledger"],
      reachableResourceIds: ["checkout-api", "orders-ledger"],
    },
  ]);
  assert.deepEqual(routeById(result, "checkout-write"), {
    routeId: "checkout-write",
    path: "/checkout/*",
    status: "home-routed",
    targetCamp: "prod-us",
    policy: { kind: "home", camp: "prod-us" },
    reachableResourceIds: ["checkout-api", "orders-ledger"],
    reason: "route reaches single-writer resources: orders-ledger",
  });
  assert.deepEqual(result.events, []);
});

test("can-deploy allows all-eligible cost routes and chooses the cheapest healthy Camp", () => {
  const result = evaluateCostRoutingPlan({
    domain: "shop.example",
    routes: [costRoute("catalog-read", "/catalog/*", "prod-us", ["catalog-api"])],
    resources: [
      resource("catalog-api", "active-active-eventual", ["catalog-cache"]),
      resource("catalog-cache", "pinned"),
    ],
    camps: [camp("prod-us", 10), camp("prod-eu", 4), camp("prod-apac", 7)],
  });

  assert.equal(result.canDeploy.allowed, true);
  assert.deepEqual(result.canDeploy.violations, []);
  assert.deepEqual(routeById(result, "catalog-read"), {
    routeId: "catalog-read",
    path: "/catalog/*",
    status: "cost-routed",
    targetCamp: "prod-eu",
    policy: { kind: "cost", camp: "prod-eu" },
    reachableResourceIds: ["catalog-api", "catalog-cache"],
    reason: "cheapest healthy Camp is prod-eu at 4",
  });
  assert.deepEqual(result.events, [
    {
      type: "domain.RoutingChanged",
      domain: "shop.example",
      routeId: "catalog-read",
      data: {
        policy: "cost",
        targetCamp: "prod-eu",
        previousTargetCamp: undefined,
        reason: "cheapest healthy Camp is prod-eu at 4",
      },
    },
  ]);
});

test("can-deploy fails closed for non-active-active and non-pinned topology", () => {
  const result = evaluateCostRoutingPlan({
    domain: "shop.example",
    routes: [costRoute("legacy-read", "/legacy/*", "prod-us", ["legacy-api"])],
    resources: [resource("legacy-api", "unknown-topology")],
    camps: [camp("prod-us", 10), camp("prod-eu", 4)],
  });

  assert.equal(result.canDeploy.allowed, false);
  assert.deepEqual(result.canDeploy.violations, [
    {
      routeId: "legacy-read",
      reason: "cost routing reaches cost-ineligible resources: legacy-api",
      singleWriterResourceIds: [],
      reachableResourceIds: ["legacy-api"],
    },
  ]);
  assert.equal(routeById(result, "legacy-read").targetCamp, "prod-us");
  assert.equal(routeById(result, "legacy-read").status, "home-routed");
  assert.equal(routeById(result, "legacy-read").reason, "route reaches cost-ineligible resources: legacy-api");
});

test("mixed domains send single-writer paths home while cost-routing eligible paths", () => {
  const result = evaluateCostRoutingPlan({
    domain: "shop.example",
    routes: [
      homeRoute("checkout-write", "/checkout/*", "prod-us", ["checkout-api"]),
      costRoute("catalog-read", "/catalog/*", "prod-us", ["catalog-api"]),
    ],
    resources: [
      resource("checkout-api", "active-active-eventual", ["orders-ledger"]),
      resource("orders-ledger", "single-writer"),
      resource("catalog-api", "active-active-eventual", ["catalog-cache"]),
      resource("catalog-cache", "pinned"),
    ],
    camps: [camp("prod-us", 10), camp("prod-eu", 4)],
  });

  assert.equal(result.canDeploy.allowed, true);
  assert.deepEqual(routeById(result, "checkout-write"), {
    routeId: "checkout-write",
    path: "/checkout/*",
    status: "home-routed",
    targetCamp: "prod-us",
    policy: { kind: "home", camp: "prod-us" },
    reachableResourceIds: ["checkout-api", "orders-ledger"],
    reason: "explicit home route",
  });
  assert.deepEqual(routeById(result, "catalog-read"), {
    routeId: "catalog-read",
    path: "/catalog/*",
    status: "cost-routed",
    targetCamp: "prod-eu",
    policy: { kind: "cost", camp: "prod-eu" },
    reachableResourceIds: ["catalog-api", "catalog-cache"],
    reason: "cheapest healthy Camp is prod-eu at 4",
  });
  assert.doesNotThrow(() => assertNoSingleWriterCostRoutes(result));
});

test("a topology change removes cost eligibility on the next plan", () => {
  const planBeforeTopologyChange = evaluateCostRoutingPlan({
    domain: "shop.example",
    routes: [costRoute("checkout-read", "/checkout/*", "prod-us", ["checkout-api"])],
    resources: [
      resource("checkout-api", "active-active-eventual", ["orders-projection"]),
      resource("orders-projection", "active-active-eventual"),
    ],
    camps: [camp("prod-us", 10), camp("prod-eu", 4)],
  });

  assert.equal(planBeforeTopologyChange.canDeploy.allowed, true);
  assert.equal(routeById(planBeforeTopologyChange, "checkout-read").targetCamp, "prod-eu");

  const nextPlan = evaluateCostRoutingPlan({
    domain: "shop.example",
    routes: [costRoute("checkout-read", "/checkout/*", "prod-us", ["checkout-api"])],
    resources: [
      resource("checkout-api", "active-active-eventual", ["orders-projection"]),
      resource("orders-projection", "single-writer"),
    ],
    camps: [camp("prod-us", 10), camp("prod-eu", 4)],
  });

  assert.equal(nextPlan.canDeploy.allowed, false);
  assert.deepEqual(routeById(nextPlan, "checkout-read"), {
    routeId: "checkout-read",
    path: "/checkout/*",
    status: "home-routed",
    targetCamp: "prod-us",
    policy: { kind: "home", camp: "prod-us" },
    reachableResourceIds: ["checkout-api", "orders-projection"],
    reason: "route reaches single-writer resources: orders-projection",
  });
});

test("cost flips are hysteresis-bounded so price oscillation does not thrash routing", () => {
  const request = {
    domain: "shop.example",
    routes: [costRoute("catalog-read", "/catalog/*", "prod-us", ["catalog-api"])],
    resources: [resource("catalog-api", "active-active-eventual")],
    hysteresis: { minimumSavingsFraction: 0.15 },
    previousDecisions: {
      "catalog-read": { targetCamp: "prod-us" },
    },
  };

  const oscillatingPlans = [
    evaluateCostRoutingPlan({ ...request, camps: [camp("prod-us", 10), camp("prod-eu", 9.4)] }),
    evaluateCostRoutingPlan({ ...request, camps: [camp("prod-us", 9.5), camp("prod-eu", 9)] }),
    evaluateCostRoutingPlan({ ...request, camps: [camp("prod-us", 10), camp("prod-eu", 9.6)] }),
  ];

  for (const plan of oscillatingPlans) {
    assert.equal(routeById(plan, "catalog-read").targetCamp, "prod-us");
    assert.equal(routeById(plan, "catalog-read").status, "cost-held");
    assert.deepEqual(plan.events, []);
  }

  const decisivePlan = evaluateCostRoutingPlan({
    ...request,
    camps: [camp("prod-us", 10), camp("prod-eu", 7.5)],
  });

  assert.equal(routeById(decisivePlan, "catalog-read").targetCamp, "prod-eu");
  assert.equal(routeById(decisivePlan, "catalog-read").status, "cost-routed");
  assert.deepEqual(decisivePlan.events, [
    {
      type: "domain.RoutingChanged",
      domain: "shop.example",
      routeId: "catalog-read",
      data: {
        policy: "cost",
        targetCamp: "prod-eu",
        previousTargetCamp: "prod-us",
        reason: "prod-eu is 25.00% cheaper than prod-us, exceeding 15.00% hysteresis",
      },
    },
  ]);
});

test("can-deploy assertion flags any single-writer route that is cost-routed", () => {
  const badPlan = {
    routes: [
      {
        routeId: "bad-checkout-route",
        policy: { kind: "cost", camp: "prod-eu" },
        reachableResourceIds: ["checkout-api", "orders-ledger"],
      },
    ],
    resources: [resource("checkout-api", "active-active-eventual"), resource("orders-ledger", "single-writer")],
  };

  assert.throws(
    () => assertNoSingleWriterCostRoutes(badPlan),
    /bad-checkout-route cost-routes single-writer resources: orders-ledger/,
  );

  const goodPlan = {
    routes: [
      {
        routeId: "checkout-home",
        policy: { kind: "home", camp: "prod-us" },
        reachableResourceIds: ["orders-ledger"],
      },
      {
        routeId: "catalog-cost",
        policy: { kind: "cost", camp: "prod-eu" },
        reachableResourceIds: ["catalog-api"],
      },
    ],
    resources: [resource("orders-ledger", "single-writer"), resource("catalog-api", "active-active-eventual")],
  };

  assert.doesNotThrow(() => assertNoSingleWriterCostRoutes(goodPlan));
});

function routeById(plan, routeId) {
  return plan.routes.find((route) => route.routeId === routeId);
}

function costRoute(routeId, path, homeCamp, entryResourceIds) {
  return {
    routeId,
    path,
    homeCamp,
    entryResourceIds,
    policy: { kind: "cost" },
  };
}

function homeRoute(routeId, path, homeCamp, entryResourceIds) {
  return {
    routeId,
    path,
    homeCamp,
    entryResourceIds,
    policy: { kind: "home" },
  };
}

function resource(id, replicaTopology, dependencies = []) {
  return { id, replicaTopology, dependencies };
}

function camp(campName, effectiveMarginalCost) {
  return {
    camp: campName,
    healthy: true,
    validated: true,
    effectiveMarginalCost,
  };
}
