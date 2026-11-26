import assert from "node:assert/strict";
import { test } from "vitest";

import {
  CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION,
  enforceConnectivityCanDeploy,
  gateRuntimeResidencyRead,
  normalizeConnectivityTier
} from "../src/connectivity-policy-enforcement.js";
import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier
} from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";

test("prod no-public deny ceiling blocks public-tier plans at can-deploy", () => {
  const result = enforceConnectivityCanDeploy({
    plan: connectivityPlan({ tier: ConnectivityTier.PUBLIC_MTLS }),
    environment: "prod",
    policyDecision: policyDecision({
      effect: "deny",
      reason: "mandatory-ceiling:no-public-tier",
      constraints: {
        maxTier: ConnectivityTier.OVERLAY_MESH,
        forbiddenTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.policy.denied");
  assert.equal(result.request.action, "connectivity:can-deploy");
  assert.equal(result.request.context.publicExposure, true);
  assert.equal(result.enforcementEvent.schemaVersion, CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION);
  assert.equal(result.enforcementEvent.type, "connectivity.PolicyBlocked");
  assert.equal(result.enforcementEvent.data.decisionId, "policy-decision-1");
});

test("prod external-egress deny ceiling blocks cross-Yard connectivity at can-deploy", () => {
  const result = enforceConnectivityCanDeploy({
    plan: connectivityPlan({
      source: {
        resourceId: "api",
        provider: "aws",
        region: "us-east-1",
        yardId: "yard-prod"
      },
      target: {
        resourceId: "external-crm",
        provider: "salesforce",
        region: "us",
        yardId: "external-saas"
      }
    }),
    environment: "prod",
    policyDecision: policyDecision({
      effect: "deny",
      reason: "mandatory-ceiling:no-external-egress",
      constraints: {
        forbidExternalEgress: true
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.policy.denied");
  assert.equal(result.request.context.externalEgress, true);
  assert.equal(result.enforcementEvent.data.reason, "mandatory-ceiling:no-external-egress");
});

test("external-egress ceilings fail closed if a policy decision contradicts its constraints", () => {
  const result = enforceConnectivityCanDeploy({
    plan: connectivityPlan({
      source: {
        resourceId: "api",
        provider: "aws",
        region: "us-east-1",
        yardId: "yard-prod"
      },
      target: {
        resourceId: "external-crm",
        provider: "salesforce",
        region: "us",
        yardId: "external-saas"
      }
    }),
    environment: "prod",
    policyDecision: policyDecision({
      effect: "allow",
      reason: "policy matched",
      constraints: {
        forbidExternalEgress: true
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.policy.inconsistent-allow");
});

test(".with override cannot widen past a prod tier ceiling", () => {
  const result = enforceConnectivityCanDeploy({
    plan: connectivityPlan({
      tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
      override: {
        source: ".with()",
        requestedTierName: "internet-mtls"
      }
    }),
    environment: "prod",
    policyDecision: policyDecision({
      effect: "deny",
      reason: "mandatory-ceiling:no-public-tier",
      constraints: {
        maxTier: ConnectivityTier.OVERLAY_MESH,
        forbiddenTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.override.policy-widening");
  assert.equal(result.enforcementEvent.data.requestedTier, ConnectivityTier.PUBLIC_MTLS);
});

test("alternate public tier names do not bypass ceiling checks", () => {
  assert.equal(normalizeConnectivityTier("tier-5"), ConnectivityTier.PUBLIC_MTLS);
  assert.equal(normalizeConnectivityTier("public-endpoint"), ConnectivityTier.PUBLIC_MTLS);

  const result = enforceConnectivityCanDeploy({
    plan: connectivityPlan({
      tier: ConnectivityTier.OVERLAY_MESH,
      override: {
        source: ".with()",
        requestedTierName: "tier-5"
      }
    }),
    environment: "prod",
    policyDecision: policyDecision({
      effect: "deny",
      reason: "mandatory-ceiling:no-public-tier",
      constraints: {
        maxTier: ConnectivityTier.OVERLAY_MESH,
        forbiddenTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.override.policy-widening");
});

test("runtime residency gate can pin a cross-Camp read stream to an allowed region", () => {
  const result = gateRuntimeResidencyRead({
    stream: residencyStream({
      targetCamp: { id: "camp-analytics", region: "us-east-1" }
    }),
    topologySnapshot: topologySnapshot({ seq: 42 }),
    policyDecision: policyDecision({
      phase: "runtime",
      effect: "allow",
      obligations: [{ type: "region-pin", region: "eu-west-1" }],
      evidence: { topologySeq: 42, policyIds: ["pack-prod-residency"] }
    })
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, "region-pinned");
  assert.equal(result.route.pinnedRegion, "eu-west-1");
  assert.equal(result.enforcementEvent.type, "connectivity.ResidencyPinned");
});

test("runtime residency gate blocks denied cross-Camp read streams", () => {
  const result = gateRuntimeResidencyRead({
    stream: residencyStream(),
    topologySnapshot: topologySnapshot({ seq: 11 }),
    policyDecision: policyDecision({
      phase: "runtime",
      effect: "deny",
      reason: "residency:cross-region-forbidden",
      evidence: { topologySeq: 11, policyIds: ["pack-prod-residency"] }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.residency.denied");
  assert.equal(result.enforcementEvent.type, "connectivity.RuntimeResidencyDenied");
});

test("topology changes force runtime residency re-gating instead of grandfathering old allow", () => {
  const result = gateRuntimeResidencyRead({
    stream: residencyStream({
      targetCamp: { id: "camp-reporting", region: "us-east-1" }
    }),
    topologySnapshot: topologySnapshot({ seq: 43 }),
    policyDecision: policyDecision({
      phase: "runtime",
      effect: "allow",
      obligations: [{ type: "region-pin", region: "eu-west-1" }],
      evidence: { topologySeq: 42, policyIds: ["pack-prod-residency"] }
    })
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, "connectivity.runtime.regate-required");
});

function connectivityPlan(overrides = {}) {
  return {
    schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
    edgeId: "edge-api-db",
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    source: {
      resourceId: "api",
      provider: "aws",
      region: "us-east-1",
      yardId: "yard-prod"
    },
    target: {
      resourceId: "db",
      provider: "gcp",
      region: "us-east1",
      yardId: "yard-prod"
    },
    endpoints: {
      sourceLogicalName: "ctx.bindings.api",
      targetLogicalName: "ctx.bindings.db"
    },
    identity: {
      source: "spiffe://tenant-a/bindle-shop/api",
      target: "spiffe://tenant-a/bindle-shop/db"
    },
    parameters: {
      interconnectKind: "private-service",
      serviceRef: "aws<->gcp"
    },
    ...overrides
  };
}

function residencyStream(overrides = {}) {
  return {
    streamId: "stream-orders",
    sourceCamp: { id: "camp-api", region: "eu-west-1" },
    targetCamp: { id: "camp-analytics", region: "us-east-1" },
    dataResidency: {
      tag: "eu-personal-data",
      allowedRegions: ["eu-west-1"]
    },
    ...overrides
  };
}

function topologySnapshot({ seq }) {
  return {
    seq,
    camps: {
      "camp-api": { region: "eu-west-1" },
      "camp-analytics": { region: "us-east-1" },
      "camp-reporting": { region: "us-east-1" }
    }
  };
}

function policyDecision(overrides = {}) {
  return {
    decisionId: "policy-decision-1",
    phase: "can-deploy",
    effect: "allow",
    reason: "policy matched",
    evidence: { policyIds: ["pack-prod-network"] },
    obligations: [],
    ...overrides
  };
}
