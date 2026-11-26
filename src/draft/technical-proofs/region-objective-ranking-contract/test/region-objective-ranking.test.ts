import assert from "node:assert/strict";
import { test } from "vitest";

import {
  decideRegionObjectivePlacement
} from "../src/region-objective-ranking.js";
import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";

const context = Object.freeze({
  deploymentId: "deploy-orders-prod",
  resourceId: "orders-db",
  resourceType: "database",
  resourceClass: "ha",
  envType: "production",
  env: "prod",
  app: "orders",
  tenant: "tenant-acme",
  allowedRegions: ["us-east-1", "us-east-2"],
  colocated: [
    {
      resourceId: "orders-api",
      provider: "aws",
      allowedRegions: ["us-east-1", "us-east-2"]
    }
  ]
});

test("two full tied candidates resolve by configured objective and emit rationale", () => {
  const catalog = catalogWith([
    definition("aws-cheapest", "aws", {
      regions: [region("us-east-1", { cost: 5, egressCost: 3, latency: 40, carbon: 8 })]
    }),
    definition("azure-fastest", "azure", {
      regions: [region("us-east-1", { cost: 9, latency: 12, carbon: 2 })]
    })
  ]);

  const byCost = decideRegionObjectivePlacement({ catalog, context, objective: "cost" });
  const byLatency = decideRegionObjectivePlacement({ catalog, context, objective: "latency" });

  assert.equal(byCost.ok, true);
  assert.equal(byCost.winner.definitionId, "aws-cheapest");
  assert.equal(byCost.winner.region, "us-east-1");
  assert.equal(byCost.matchEvent.type, "match.Decided");
  assert.equal(byCost.matchEvent.data.objective, "cost");
  assert.equal(byCost.matchEvent.data.ranking[0].objectiveScore, 8);
  assert.equal(byCost.matchEvent.data.ranking[0].region, "us-east-1");
  assert.match(byCost.matchEvent.data.ranking[0].rationale, /objective=cost/);
  assert.equal(validateControlPlaneEvent(byCost.matchEvent).ok, true);
  assert.equal(byCost.plannedEvent.type, "deployment.Planned");
  assert.equal(validateControlPlaneEvent(byCost.plannedEvent).ok, true);
  assert.equal(byCost.deploymentPlan.meta.objective, "cost");
  assert.equal(byCost.deploymentPlan.meta.rankingRationale[0].definitionId, "aws-cheapest");
  assert.equal(byCost.deploymentPlan.meta.rankingRationale[0].region, "us-east-1");

  assert.equal(byLatency.ok, true);
  assert.equal(byLatency.winner.definitionId, "azure-fastest");
  assert.equal(byLatency.matchEvent.data.objective, "latency");
});

test("carbon objective ranks by carbon intensity and records rationale", () => {
  const decision = decideRegionObjectivePlacement({
    context,
    objective: "carbon",
    catalog: catalogWith([
      definition("low-cost-high-carbon", "aws", {
        regions: [region("us-east-1", { cost: 1, latency: 8, carbon: 50 })]
      }),
      definition("low-carbon", "aws", {
        regions: [region("us-east-2", { cost: 20, latency: 35, carbon: 2 })]
      })
    ])
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.definitionId, "low-carbon");
  assert.equal(decision.winner.region, "us-east-2");
  assert.equal(decision.matchEvent.data.objective, "carbon");
  assert.equal(decision.matchEvent.data.ranking[0].objectiveScore, 2);
  assert.match(decision.matchEvent.data.ranking[0].rationale, /objective=carbon/);
  assert.equal(validateControlPlaneEvent(decision.matchEvent).ok, true);
});

test("colocated resources land in a shared region or fail with a precise rejection", () => {
  const catalog = catalogWith([
    definition("aws-regional", "aws", {
      regions: [
        region("us-east-1", { cost: 10, latency: 30, carbon: 3 }),
        region("us-west-2", { cost: 1, latency: 50, carbon: 8 })
      ]
    })
  ]);
  const onlyEastContext = {
    ...context,
    allowedRegions: ["us-east-1", "us-west-2"],
    colocated: [
      {
        resourceId: "orders-api",
        provider: "aws",
        allowedRegions: ["us-east-1"]
      }
    ]
  };

  const decision = decideRegionObjectivePlacement({
    catalog,
    context: onlyEastContext,
    objective: "cost"
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.region, "us-east-1");

  const conflict = decideRegionObjectivePlacement({
    catalog,
    context: {
      ...onlyEastContext,
      allowedRegions: ["us-west-2"]
    },
    objective: "cost"
  });

  assert.equal(conflict.ok, false);
  assert.match(conflict.rejectedCandidates[0].reason, /region\.colocation\.unsatisfied/);
});

test("missing cost signal degrades to the next deterministic objective signal", () => {
  const decision = decideRegionObjectivePlacement({
    context,
    objective: "cost",
    catalog: catalogWith([
      definition("missing-cost-slow", "aws", {
        regions: [region("us-east-1", { latency: 80, carbon: 5 })]
      }),
      definition("missing-cost-fast", "aws", {
        regions: [region("us-east-1", { latency: 15, carbon: 9 })]
      })
    ])
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.definitionId, "missing-cost-fast");
  assert.equal(decision.matchEvent.data.ranking[0].definitionId, "missing-cost-fast");
});

test("true objective ties fall through to stable id and replay to identical events", () => {
  const catalog = catalogWith([
    definition("beta", "aws", {
      regions: [region("us-east-1", { cost: 3, latency: 20, carbon: 2 })]
    }),
    definition("alpha", "aws", {
      regions: [region("us-east-1", { cost: 3, latency: 20, carbon: 2 })]
    })
  ]);

  const first = decideRegionObjectivePlacement({ catalog, context, objective: "cost" });
  const replay = decideRegionObjectivePlacement({ catalog, context, objective: "cost" });

  assert.equal(first.ok, true);
  assert.equal(first.winner.definitionId, "alpha");
  assert.equal(first.tie, true);
  assert.deepEqual(first.tiedDefinitionIds, ["alpha", "beta"]);
  assert.deepEqual(first.matchEvent, replay.matchEvent);
  assert.deepEqual(first.plannedEvent, replay.plannedEvent);
});

test("cross-provider colocated edges are penalized and recorded in rationale", () => {
  const decision = decideRegionObjectivePlacement({
    context,
    objective: "single-provider",
    catalog: catalogWith([
      definition("aws-same-provider", "aws", {
        regions: [region("us-east-1", { cost: 7, latency: 40, carbon: 10 })]
      }),
      definition("azure-cross-provider", "azure", {
        regions: [region("us-east-1", { cost: 2, latency: 10, carbon: 1, egressCost: 20 })]
      })
    ])
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.definitionId, "aws-same-provider");
  assert.match(
    decision.matchEvent.data.ranking[0].rationale,
    /cross-provider-egress=false/
  );
});

test("cost objective ranks by effective cost including egress", () => {
  const decision = decideRegionObjectivePlacement({
    context,
    objective: "cost",
    catalog: catalogWith([
      definition("base-cheap-egress-expensive", "azure", {
        regions: [region("eastus", { cost: 1, egressCost: 100, latency: 5, carbon: 1 })]
      }),
      definition("effective-cheapest", "aws", {
        regions: [region("us-east-1", { cost: 20, egressCost: 2, latency: 50, carbon: 3 })]
      })
    ])
  });

  assert.equal(decision.winner.definitionId, "effective-cheapest");
  assert.equal(decision.matchEvent.data.ranking[0].objectiveScore, 22);
});

test("malformed match criteria reject one candidate without poisoning the decision", () => {
  const decision = decideRegionObjectivePlacement({
    context,
    objective: "cost",
    catalog: catalogWith([
      definition("invalid-region-criterion", "aws", {
        match: { region: "us-east-1" },
        regions: [region("us-east-1", { cost: 1, latency: 1, carbon: 1 })]
      }),
      definition("valid", "aws", {
        regions: [region("us-east-1", { cost: 5, latency: 20, carbon: 3 })]
      })
    ])
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.definitionId, "valid");
  assert.match(decision.rejectedCandidates[0].reason, /unknown criteria fields: region/);
});

function catalogWith(definitions) {
  return {
    contentHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    definitions
  };
}

function definition(id, provider, overrides = {}) {
  return {
    id,
    type: "database",
    provider,
    driver: "terraform",
    capability: "full",
    match: {
      envType: "production",
      resourceClass: "ha"
    },
    priority: 10,
    regions: [],
    ...overrides
  };
}

function region(id, metrics) {
  return { id, ...metrics };
}
