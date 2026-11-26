import assert from "node:assert/strict";
import { test } from "vitest";

import { createResourceCatalog } from "../../resource-definition-driver-contract/src/resource-definition-driver-contract.js";
import { validateControlPlaneEvent } from "../../control-plane-event-schema-contract/src/control-plane-events.js";
import {
  capabilityDecisionToMatchEvent,
  capabilityDecisionToPlanRejectedEvent,
  capabilityRequest,
  decideCapabilityNegotiatedDefinition,
  defineCapability
} from "../src/capability-negotiation.js";

const context = Object.freeze({
  deploymentId: "dep-orders-prod",
  resourceType: "database",
  envType: "production",
  env: "prod-us",
  app: "orders",
  tenant: "acme",
  resourceClass: "ha",
  resourceId: "orders-db"
});

test("full capability match passes clean and emits match.Decided", () => {
  const catalog = createCatalog([
    definition("aws-rds-ha", { envType: "production", resourceClass: "ha" }, "aws"),
    definition("azure-flexible", { envType: "production" }, "azure")
  ]);

  const decision = decideCapabilityNegotiatedDefinition({
    catalog,
    context,
    capabilitiesByProvider: {
      aws: [capability("aws", ["managed", "ha"])],
      azure: [capability("azure", ["managed"])]
    },
    portRequests: [
      capabilityRequest({ port: "database", features: ["managed", "ha"], strictness: "require" })
    ]
  });
  const event = capabilityDecisionToMatchEvent(decision, {
    id: "evt-match-orders-db",
    seq: 20,
    causationId: "deployment.Planned:orders"
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "aws-rds-ha");
  assert.equal(decision.capability.level, "full");
  assert.deepEqual(decision.planWarnings, []);
  assert.equal(validateControlPlaneEvent(event).ok, true);
  assert.equal(event.data.winner, "aws-rds-ha");
});

test("preferred partial capability accepts with PlanWarning", () => {
  const decision = decideCapabilityNegotiatedDefinition({
    catalog: createCatalog([
      definition("azure-flexible", { envType: "production" }, "azure")
    ]),
    context,
    capabilitiesByProvider: {
      azure: [
        defineCapability({
          provider: "azure",
          port: "database",
          features: ["managed"],
          remediation: "Use aws-rds-ha for native HA."
        })
      ]
    },
    portRequests: [
      capabilityRequest({ port: "database", features: ["managed"], strictness: "require" }),
      capabilityRequest({ port: "database", features: ["ha"], strictness: "prefer" })
    ]
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "azure-flexible");
  assert.equal(decision.capability.level, "partial");
  assert.deepEqual(decision.capability.missingPreferred, [
    {
      port: "database",
      feature: "ha",
      reason: "feature-missing",
      remediation: "Use aws-rds-ha for native HA."
    }
  ]);
  assert.equal(decision.planWarnings[0].kind, "capability.prefer.degraded");
  assert.equal(decision.planWarnings[0].feature, "ha");
});

test("required capability miss fails closed with machine-readable deployment.PlanRejected", () => {
  const decision = decideCapabilityNegotiatedDefinition({
    catalog: createCatalog([
      definition("azure-flexible", { envType: "production" }, "azure")
    ]),
    context,
    capabilitiesByProvider: {
      azure: [capability("azure", ["managed"])]
    },
    portRequests: [
      capabilityRequest({ port: "database", features: ["managed", "ha"], strictness: "require" })
    ]
  });
  const event = capabilityDecisionToPlanRejectedEvent(decision, {
    id: "evt-plan-rejected-db",
    seq: 21,
    causationId: "deployment.Planned:orders"
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.rejection.code, "capability.require.unsatisfied");
  assert.match(decision.rejectedCandidates[0].reason, /capability\.require\.unsatisfied/);
  assert.match(decision.rejectedCandidates[0].reason, /database\.ha/);
  assert.equal(event.type, "deployment.PlanRejected");
  assert.match(event.data.reason, /capability\.require\.unsatisfied/);
  assert.match(event.data.reason, /database\.ha/);
  assert.equal(validateControlPlaneEvent(event).ok, true);
  assert.throws(() => capabilityDecisionToMatchEvent(decision), /cannot emit match.Decided/);
});

test("more specific require-missing definition falls through to next satisfying candidate", () => {
  const catalog = createCatalog([
    definition("specific-azure", { envType: "production", app: "orders", resourceClass: "ha" }, "azure"),
    definition("general-aws", { envType: "production" }, "aws")
  ]);

  const decision = decideCapabilityNegotiatedDefinition({
    catalog,
    context,
    capabilitiesByProvider: {
      azure: [capability("azure", ["managed"])],
      aws: [capability("aws", ["managed", "ha"])]
    },
    portRequests: [
      capabilityRequest({ port: "database", features: ["managed", "ha"], strictness: "require" })
    ]
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "general-aws");
  assert.deepEqual(
    decision.rejectedCandidates.map((candidate) => candidate.definitionId),
    ["specific-azure"]
  );
  assert.match(decision.rejectedCandidates[0].reason, /database\.ha/);
});

test("prefer plus unavailable capability degrades instead of hard rejecting", () => {
  const decision = decideCapabilityNegotiatedDefinition({
    catalog: createCatalog([
      definition("local-dev-db", { envType: "production" }, "local")
    ]),
    context,
    capabilitiesByProvider: {
      local: [defineCapability({ provider: "local", port: "cache", features: ["in-memory"] })]
    },
    portRequests: [
      capabilityRequest({ port: "database", features: ["ha"], strictness: "prefer" })
    ]
  });

  assert.equal(decision.ok, true);
  assert.equal(decision.winner.id, "local-dev-db");
  assert.equal(decision.capability.level, "none");
  assert.equal(decision.planWarnings[0].reason, "capability-unavailable");
});

test("conflicting require/prefer keeps the hard requirement fail-closed", () => {
  const decision = decideCapabilityNegotiatedDefinition({
    catalog: createCatalog([
      definition("azure-flexible", { envType: "production" }, "azure")
    ]),
    context,
    capabilitiesByProvider: {
      azure: [capability("azure", ["managed"])]
    },
    portRequests: [
      capabilityRequest({ port: "database", features: ["ha"], strictness: "prefer" }),
      capabilityRequest({ port: "database", features: ["ha"], strictness: "require" })
    ]
  });

  assert.equal(decision.ok, false);
  assert.equal(decision.rejection.code, "capability.require.unsatisfied");
  assert.match(decision.rejectedCandidates[0].reason, /database\.ha/);
});

function createCatalog(definitions) {
  const catalog = createResourceCatalog({ id: "capability-negotiation-fixture" });
  for (const resourceDefinition of definitions) {
    catalog.register(resourceDefinition);
  }
  return catalog;
}

function definition(id, match, provider) {
  return {
    id,
    type: "database",
    engine: "postgres",
    provider,
    driver: "terraform",
    match,
    priority: 0
  };
}

function capability(provider, features) {
  return defineCapability({ provider, port: "database", features });
}
