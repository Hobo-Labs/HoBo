import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import {
  CONNECTIVITY_PLAN_SCHEMA_VERSION,
  ConnectivityTier,
  decideConnectivityTier,
  rejectPolicyWideningOverride,
  roundTripConnectivityPlan,
  validateConnectivityPlan
} from "../src/connectivity-tier-ir.js";

const workloadIdentity = {
  source: "spiffe://tenant-acme/shop/api",
  target: "spiffe://tenant-acme/shop/db"
};

test("connectivity plan JSON schema artifact parses and pins the five tiers", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/hobo.connectivity-plan.v1.schema.json", import.meta.url), "utf8"));

  assert.equal(schema.$id, "https://hobo.dev/schemas/hobo.connectivity-plan.v1.schema.json");
  assert.deepEqual(schema.required, [
    "schemaVersion",
    "edgeId",
    "source",
    "target",
    "tier",
    "endpoints",
    "identity",
    "parameters"
  ]);
  assert.deepEqual(schema.properties.tier.enum, Object.values(ConnectivityTier));
});

test("connectivity plan schema validates and round-trips every tier", () => {
  for (const tier of Object.values(ConnectivityTier)) {
    const plan = {
      schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION,
      edgeId: `shop-api-to-db-${tier}`,
      source: { resourceId: "shop.api", provider: "aws", region: "us-east-1", yardId: "yard-aws" },
      target: { resourceId: "shop.db", provider: tier <= 2 ? "aws" : "azure", region: tier === 1 ? "us-east-1" : "westus3", yardId: tier >= 3 ? "yard-azure" : "yard-aws" },
      tier,
      endpoints: {
        sourceLogicalName: "ctx.bindings.db",
        targetLogicalName: "shop.db"
      },
      identity: workloadIdentity,
      parameters: tierParameters(tier),
      residency: { tag: "us-only" },
      policy: { maxTier: ConnectivityTier.PUBLIC_MTLS, allowPublicMtls: true },
      override: { requestedTier: tier, reason: "golden fixture" }
    };

    const validation = validateConnectivityPlan(plan);
    const roundTripped = roundTripConnectivityPlan(plan);

    assert.equal(validation.ok, true);
    assert.deepEqual(roundTripped, plan);
  }
});

test("golden bind edges map to the expected connectivity tier values", () => {
  const cases = [
    {
      name: "same provider and region uses tier 1 native private networking",
      edge: edge({ sourceProvider: "aws", targetProvider: "aws", sourceRegion: "us-east-1", targetRegion: "us-east-1" }),
      expectedTier: ConnectivityTier.SAME_PROVIDER_REGION
    },
    {
      name: "same provider cross region uses tier 2 backbone",
      edge: edge({ sourceProvider: "aws", targetProvider: "aws", sourceRegion: "us-east-1", targetRegion: "us-west-2" }),
      expectedTier: ConnectivityTier.SAME_PROVIDER_CROSS_REGION
    },
    {
      name: "cross provider with private interconnect support uses tier 3",
      edge: edge({ sourceProvider: "aws", targetProvider: "azure", targetRegion: "eastus", capabilities: ["private-interconnect"] }),
      expectedTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT
    },
    {
      name: "cross provider without interconnect but with overlay support uses tier 4",
      edge: edge({ sourceProvider: "aws", targetProvider: "gcp", targetRegion: "us-central1", capabilities: ["overlay-mesh"] }),
      expectedTier: ConnectivityTier.OVERLAY_MESH
    },
    {
      name: "public endpoint with mTLS support uses tier 5 as last resort",
      edge: edge({ sourceProvider: "cloudflare", targetProvider: "fly", targetRegion: "iad", capabilities: ["public-mtls"] }),
      expectedTier: ConnectivityTier.PUBLIC_MTLS
    }
  ];

  for (const { name, edge: bindEdge, expectedTier } of cases) {
    const decision = decideConnectivityTier(bindEdge);

    assert.equal(decision.ok, true, name);
    assert.equal(decision.plan.tier, expectedTier, name);
    assert.equal(decision.plan.identity.source, workloadIdentity.source, name);
    assert.equal(decision.plan.identity.target, workloadIdentity.target, name);
  }
});

test("unknown or unsupported tiers fail closed instead of silently defaulting", () => {
  assert.deepEqual(validateConnectivityPlan({ schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION, tier: 0 }), {
    ok: false,
    code: "connectivity.tier.unsupported",
    reason: "tier must be one of 1, 2, 3, 4, 5"
  });

  assert.throws(
    () => roundTripConnectivityPlan({ schemaVersion: CONNECTIVITY_PLAN_SCHEMA_VERSION, tier: "native-private" }),
    /connectivity\.tier\.unsupported/
  );
});

test("bind edge with no resolvable tier errors and never defaults to public", () => {
  const decision = decideConnectivityTier(edge({
    sourceProvider: "aws",
    targetProvider: "unknown-provider",
    targetRegion: "moon-1",
    capabilities: []
  }));

  assert.equal(decision.ok, false);
  assert.equal(decision.code, "connectivity.tier.unresolvable");
  assert.match(decision.reason, /no connectivity tier resolved/);
  assert.equal("plan" in decision, false);
});

test("override that widens beyond policy is rejected at the IR boundary", () => {
  const base = decideConnectivityTier(edge({
    sourceProvider: "aws",
    targetProvider: "gcp",
    targetRegion: "us-central1",
    capabilities: ["overlay-mesh"]
  })).plan;

  const widened = {
    ...base,
    tier: ConnectivityTier.PUBLIC_MTLS,
    policy: {
      maxTier: ConnectivityTier.OVERLAY_MESH,
      allowPublicMtls: false
    },
    override: {
      requestedTier: ConnectivityTier.PUBLIC_MTLS,
      reason: "try public shortcut"
    }
  };

  assert.deepEqual(rejectPolicyWideningOverride(widened), {
    ok: false,
    code: "connectivity.override.policy-widening",
    reason: "override requested tier 5 beyond policy max tier 4"
  });
  assert.deepEqual(validateConnectivityPlan(widened), rejectPolicyWideningOverride(widened));

  assert.deepEqual(rejectPolicyWideningOverride({
    ...base,
    policy: {
      maxTier: ConnectivityTier.OVERLAY_MESH,
      allowPublicMtls: false
    },
    override: {
      requestedTier: ConnectivityTier.PUBLIC_MTLS,
      reason: "preflight public shortcut"
    }
  }), {
    ok: false,
    code: "connectivity.override.policy-widening",
    reason: "override requested tier 5 beyond policy max tier 4"
  });
});

function edge({
  sourceProvider,
  targetProvider,
  sourceRegion = "us-east-1",
  targetRegion,
  capabilities = []
}) {
  return {
    edgeId: "shop.api->shop.db",
    source: { resourceId: "shop.api", provider: sourceProvider, region: sourceRegion, yardId: `yard-${sourceProvider}` },
    target: { resourceId: "shop.db", provider: targetProvider, region: targetRegion, yardId: `yard-${targetProvider}` },
    endpoints: {
      sourceLogicalName: "ctx.bindings.db",
      targetLogicalName: "shop.db"
    },
    identity: workloadIdentity,
    availableCapabilities: capabilities,
    residency: { tag: "us-only" },
    policy: { maxTier: ConnectivityTier.PUBLIC_MTLS, allowPublicMtls: true }
  };
}

function tierParameters(tier) {
  switch (tier) {
    case ConnectivityTier.SAME_PROVIDER_REGION:
      return { nativeNetworkRef: "vpc-123", securityPolicyRef: "sg-db" };
    case ConnectivityTier.SAME_PROVIDER_CROSS_REGION:
      return { backboneRef: "aws-global-backbone", peeringRef: "pcx-123" };
    case ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT:
      return { interconnectKind: "privatelink", serviceRef: "svc-orders-db" };
    case ConnectivityTier.OVERLAY_MESH:
      return { meshKind: "wireguard-ebpf", meshPolicyRef: "mesh-shop" };
    case ConnectivityTier.PUBLIC_MTLS:
      return { publicEndpointRef: "https://db.example.com", mtlsRequired: true };
    default:
      throw new Error(`unexpected tier ${tier}`);
  }
}
