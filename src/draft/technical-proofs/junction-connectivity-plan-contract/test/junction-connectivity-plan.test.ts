import assert from "node:assert/strict";
import { test } from "vitest";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { projectYardManifest } from "../../yard-topology-manifest-contract/src/yard-topology-manifest.js";
import {
  planJunctionConnectivity,
  validateJunctionConnectivityPlan
} from "../src/junction-connectivity-plan.js";

test("folds member Yard manifests into mirrored per-Yard resource deliveries", () => {
  const result = planJunctionConnectivity(fixturePair());

  assert.equal(result.ok, true);
  assert.equal(result.plan.junctionEvent.type, "junction.ConnectivityInferred");
  assert.equal(result.plan.edges[0].tier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.deepEqual(Object.keys(result.plan.deliveriesByYard), ["yard-aws-prod", "yard-azure-prod"]);
  assert.equal(result.plan.deliveriesByYard["yard-aws-prod"][0].body.role, "source");
  assert.equal(result.plan.deliveriesByYard["yard-azure-prod"][0].body.role, "target");
  assert.equal(result.plan.deliveriesByYard["yard-aws-prod"][0].body.dnsRules[0].recordName, "db.internal.shop.com");
  assert.deepEqual(result.plan.sharedStateWrites, []);
});

test("rejects a delivery set that leaks another Yard's half", () => {
  const result = planJunctionConnectivity(fixturePair());
  assert.equal(result.ok, true);

  const leaked = {
    ...result.plan,
    deliveriesByYard: {
      ...result.plan.deliveriesByYard,
      "yard-aws-prod": [
        result.plan.deliveriesByYard["yard-azure-prod"][0]
      ]
    }
  };

  assert.deepEqual(validateJunctionConnectivityPlan(leaked), {
    ok: false,
    code: "junction.delivery.yard-leak",
    reason: "delivery for yard-azure-prod cannot be placed in yard-aws-prod resource log"
  });
});

test("rejects a plan whose delivery projection omits one mirrored half", () => {
  const result = planJunctionConnectivity(fixturePair());
  assert.equal(result.ok, true);

  const incomplete = {
    ...result.plan,
    deliveriesByYard: {
      "yard-aws-prod": result.plan.deliveriesByYard["yard-aws-prod"]
    }
  };

  assert.deepEqual(validateJunctionConnectivityPlan(incomplete), {
    ok: false,
    code: "junction.delivery.incomplete",
    reason: "delivery projection must contain exactly one delivered half for every edge half"
  });
});

test("refuses a cross-Yard inference that would cross a residency boundary", () => {
  assert.deepEqual(
    planJunctionConnectivity(fixturePair({ targetResidencyTag: "eu-only" })),
    {
      ok: false,
      code: "junction.residency.illegal",
      reason: "link shop.api->shop.db crosses incompatible residency tags us-only -> eu-only"
    }
  );
});

test("fails closed when a member manifest omits the peer endpoint instead of falling back to public", () => {
  assert.deepEqual(
    planJunctionConnectivity(fixturePair({
      targetOverrides: {
        exposedEndpoints: []
      },
      tierCapabilities: [
        {
          sourceYardId: "yard-aws-prod",
          targetYardId: "yard-azure-prod",
          supportedTiers: [ConnectivityTier.PUBLIC_MTLS]
        }
      ]
    })),
    {
      ok: false,
      code: "junction.manifest.asymmetric",
      reason: "link shop.api->shop.db references endpoint missing from one member Yard"
    }
  );
});

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
          ],
          ...options.sourceOverrides
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
          residencyTag: options.targetResidencyTag ?? "us-only",
          ...options.targetOverrides
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
  crossYardLinks = [],
  exposedEndpoints
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
    exposedEndpoints: exposedEndpoints ?? [
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
