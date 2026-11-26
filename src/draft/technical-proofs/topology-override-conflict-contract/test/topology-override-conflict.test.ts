import assert from "node:assert/strict";
import { test } from "vitest";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { planJunctionConnectivity } from "../../junction-connectivity-plan-contract/src/junction-connectivity-plan.js";
import { projectYardManifest } from "../../yard-topology-manifest-contract/src/yard-topology-manifest.js";
import {
  TOPOLOGY_OVERRIDE_CONFLICT_SCHEMA_VERSION,
  evaluateTopologyOverrideCanDeploy
} from "../src/topology-override-conflict.js";

test("conflicting override and Junction inference surfaces a deterministic can-deploy conflict", () => {
  const plan = assertPlan(fixturePair());
  const result = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 17,
    policyDecision: allowDecision(),
    overrides: [
      dnsOverride({
        id: "manual-db-record",
        targets: ["manual-db.override.example"],
        basis: basisFor(plan, 17)
      })
    ]
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "topology.override.conflict");
  assert.equal(result.phase, "can-deploy");
  assert.equal(result.conflict.edgeId, "yard-aws-prod:shop.api->yard-azure-prod:shop.db");
  assert.match(result.conflict.conflictId, /^[a-f0-9]{64}$/);
  assert.equal(result.decisionEvent.schemaVersion, TOPOLOGY_OVERRIDE_CONFLICT_SCHEMA_VERSION);
  assert.equal(result.decisionEvent.type, "topology.OverrideConflictDetected");
  assert.equal(result.decisionEvent.data.action, "topology:can-deploy");
});

test("Yard and Camp overrides that disagree fail identically regardless of order", () => {
  const plan = assertPlan(fixturePair());
  const yardOverride = tierOverride({
    id: "yard-public-fallback",
    scope: "yard",
    scopeId: "yard-aws-prod",
    requestedTier: ConnectivityTier.PUBLIC_MTLS,
    basis: basisFor(plan, 18)
  });
  const campOverride = tierOverride({
    id: "camp-private-interconnect",
    scope: "camp",
    scopeId: "prod-aws",
    requestedTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    basis: basisFor(plan, 18)
  });

  const first = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 18,
    policyDecision: allowDecision(),
    overrides: [yardOverride, campOverride]
  });
  const second = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 18,
    policyDecision: allowDecision(),
    overrides: [campOverride, yardOverride]
  });

  assert.equal(first.ok, false);
  assert.equal(first.code, "topology.override.scope-conflict");
  assert.equal(first.conflict.conflictId, second.conflict.conflictId);
  assert.deepEqual(first.conflict.participants, second.conflict.participants);
});

test("policy ceiling refuses a tier-widening override with a precise error", () => {
  const plan = assertPlan(fixturePair());
  const result = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 19,
    policyDecision: allowDecision({
      constraints: {
        maxTier: ConnectivityTier.OVERLAY_MESH,
        forbiddenTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    }),
    overrides: [
      tierOverride({
        id: "force-public",
        requestedTier: "public+mtls",
        basis: basisFor(plan, 19)
      })
    ]
  });

  assert.deepEqual(pick(result, ["ok", "code", "reason"]), {
    ok: false,
    code: "topology.override.policy-widening",
    reason: "override force-public requested tier 5 beyond mandatory max tier 4"
  });
  assert.equal(result.decisionEvent.type, "topology.OverrideDenied");
});

test("residency-breaking override is refused before it can change inferred connectivity", () => {
  const plan = assertPlan(fixturePair());
  const result = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 20,
    policyDecision: allowDecision(),
    overrides: [
      tierOverride({
        id: "move-db-to-eu",
        requestedTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
        residencyTag: "eu-only",
        basis: basisFor(plan, 20)
      })
    ]
  });

  assert.deepEqual(pick(result, ["ok", "code", "reason"]), {
    ok: false,
    code: "topology.override.residency-violation",
    reason: "override move-db-to-eu changes residency us-only -> eu-only for edge yard-aws-prod:shop.api->yard-azure-prod:shop.db"
  });
});

test("override cannot re-open a path that Junction inference deliberately closed", () => {
  const closed = planJunctionConnectivity(fixturePair({
    requiredTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    tierCapabilities: [
      {
        sourceYardId: "yard-aws-prod",
        targetYardId: "yard-azure-prod",
        supportedTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    ]
  }));

  const result = evaluateTopologyOverrideCanDeploy({
    closedInference: closed,
    topologySeq: 21,
    policyDecision: allowDecision(),
    overrides: [
      tierOverride({
        id: "force-public-after-closed",
        requestedTier: ConnectivityTier.PUBLIC_MTLS,
        basis: { topologySeq: 21 }
      })
    ]
  });

  assert.deepEqual(pick(result, ["ok", "code", "reason"]), {
    ok: false,
    code: "topology.override.reopens-closed-path",
    reason: "override force-public-after-closed cannot re-open an inference closed by junction.tier.unresolvable"
  });
});

test("override based on an in-flight or stale inference requires re-gating", () => {
  const plan = assertPlan(fixturePair());
  const result = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 23,
    policyDecision: allowDecision(),
    overrides: [
      tierOverride({
        id: "stale-override",
        requestedTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
        basis: {
          inferenceHash: "stale",
          topologySeq: 22
        }
      })
    ]
  });

  assert.deepEqual(pick(result, ["ok", "code", "reason"]), {
    ok: false,
    code: "topology.override.regate-required",
    reason: "override stale-override was based on stale topology seq 22; current seq is 23"
  });
  assert.equal(result.decisionEvent.type, "topology.OverrideRegateRequired");
});

test("matching overrides pass can-deploy with an auditable decision event", () => {
  const plan = assertPlan(fixturePair());
  const result = evaluateTopologyOverrideCanDeploy({
    inferredPlan: plan,
    topologySeq: 24,
    policyDecision: allowDecision(),
    overrides: [
      tierOverride({
        id: "confirm-private-interconnect",
        requestedTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
        basis: basisFor(plan, 24)
      })
    ]
  });

  assert.equal(result.ok, true);
  assert.equal(result.decisionEvent.type, "topology.OverrideAccepted");
  assert.equal(result.decisionEvent.data.overrideIds[0], "confirm-private-interconnect");
  assert.equal(result.decisionEvent.data.inferenceHash, plan.junctionEvent.contentHash);
});

function assertPlan(input) {
  const result = planJunctionConnectivity(input);
  assert.equal(result.ok, true);
  return result.plan;
}

function fixturePair(options = {}) {
  const sourceYardId = "yard-aws-prod";
  const targetYardId = "yard-azure-prod";
  const requiredTier = options.requiredTier ?? ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT;

  return {
    junctionId: "junction-shop-prod",
    members: [
      {
        manifest: projectYardManifest(yardTopology({
          yardId: sourceYardId,
          provider: "aws",
          region: "us-east-1",
          resourceId: "shop.api",
          logicalName: "shop.api",
          dnsName: "api.aws.shop.internal",
          residencyTag: options.sourceResidencyTag ?? "us-only",
          crossYardLinks: [
            {
              id: "shop.api->shop.db",
              bindleId: "shop",
              source: {
                yardId: sourceYardId,
                resourceId: "shop.api",
                endpoint: "shop.api",
                residencyTag: options.sourceResidencyTag ?? "us-only"
              },
              target: {
                yardId: targetYardId,
                resourceId: "shop.db",
                endpoint: "shop.db",
                residencyTag: options.targetResidencyTag ?? "us-only"
              },
              requiredTier,
              dnsRules: [
                {
                  recordName: "db.internal.shop.com",
                  type: "CNAME",
                  targets: ["shop-db.azure.internal"]
                }
              ]
            }
          ]
        }))
      },
      {
        manifest: projectYardManifest(yardTopology({
          yardId: targetYardId,
          provider: "azure",
          region: "eastus",
          resourceId: "shop.db",
          logicalName: "shop.db",
          dnsName: "db.azure.shop.internal",
          residencyTag: options.targetResidencyTag ?? "us-only"
        }))
      }
    ],
    tierCapabilities: options.tierCapabilities ?? [
      {
        sourceYardId,
        targetYardId,
        supportedTiers: [requiredTier]
      }
    ]
  };
}

function yardTopology({
  yardId,
  provider,
  region,
  resourceId,
  logicalName,
  dnsName,
  residencyTag,
  crossYardLinks = []
}) {
  return {
    yard: {
      id: yardId,
      provider,
      regions: [region],
      junctionId: "junction-shop-prod"
    },
    providerZones: [
      {
        id: `zone-${provider}`,
        domain: "shop.internal",
        regions: [region]
      }
    ],
    exposedEndpoints: [
      {
        logicalName,
        resourceId,
        campId: `prod-${provider}`,
        provider,
        region,
        dnsName,
        residencyTag
      }
    ],
    crossYardLinks,
    topologyOverrides: []
  };
}

function basisFor(plan, topologySeq) {
  return {
    inferenceHash: plan.junctionEvent.contentHash,
    topologySeq
  };
}

function dnsOverride(overrides = {}) {
  return {
    id: "dns-override",
    scope: "yard",
    scopeId: "yard-aws-prod",
    kind: "dns-record",
    edgeId: "yard-aws-prod:shop.api->yard-azure-prod:shop.db",
    recordName: "db.internal.shop.com",
    type: "CNAME",
    targets: ["shop-db.azure.internal"],
    reason: "operator override",
    ...overrides
  };
}

function tierOverride(overrides = {}) {
  return {
    id: "tier-override",
    scope: "yard",
    scopeId: "yard-aws-prod",
    kind: "connectivity-tier",
    edgeId: "yard-aws-prod:shop.api->yard-azure-prod:shop.db",
    requestedTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    reason: "operator override",
    ...overrides
  };
}

function allowDecision(overrides = {}) {
  return {
    decisionId: "policy-decision-1",
    phase: "can-deploy",
    effect: "allow",
    reason: "policy matched",
    evidence: { policyIds: ["pack-prod-network"] },
    constraints: {},
    ...overrides
  };
}

function pick(value, keys) {
  return Object.fromEntries(keys.map((key) => [key, value[key]]));
}
