import assert from "node:assert/strict";
import { test } from "vitest";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import { projectYardManifest } from "../../yard-topology-manifest-contract/src/yard-topology-manifest.js";
import {
  assertInferenceProperties,
  inferJunctionConnectivity,
  validateInference
} from "../src/junction-connectivity-inference.js";

test("folds two Yard manifests into deterministic mirrored per-Yard halves", () => {
  const input = fixturePair();
  const first = inferJunctionConnectivity(input);
  const second = inferJunctionConnectivity({
    ...input,
    members: [...input.members].reverse()
  });

  assert.equal(first.ok, true);
  assert.deepEqual(first, second);
  assert.equal(first.inference.event.type, "junction.ConnectivityInferred");
  assert.equal(first.inference.edges[0].tier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.deepEqual(Object.keys(first.inference.halvesByYard), ["yard-aws-prod", "yard-azure-prod"]);
  assert.equal(first.inference.halvesByYard["yard-aws-prod"][0].role, "source");
  assert.equal(first.inference.halvesByYard["yard-azure-prod"][0].role, "target");
  assert.match(first.inference.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(assertInferenceProperties(first.inference), {
    complete: true,
    sound: true,
    residencyLegal: true,
    deterministic: true
  });
});

test("property harness covers generated manifest pairs for completeness soundness residency and determinism", () => {
  for (const fixture of generatedPairs()) {
    const first = inferJunctionConnectivity(fixture);
    const second = inferJunctionConnectivity({
      ...fixture,
      members: [...fixture.members].reverse()
    });

    assert.equal(first.ok, true, fixture.junctionId);
    assert.deepEqual(first, second, fixture.junctionId);
    assert.deepEqual(assertInferenceProperties(first.inference), {
      complete: true,
      sound: true,
      residencyLegal: true,
      deterministic: true
    });
    assert.equal(first.inference.edges.length, 1, fixture.junctionId);
    assert.equal(Object.values(first.inference.halvesByYard).flat().length, 2, fixture.junctionId);
  }
});

test("asymmetric manifests fail closed when a Yard asks for an edge whose peer does not expose the endpoint", () => {
  const input = fixturePair({
    targetOverrides: {
      exposedEndpoints: []
    }
  });

  assert.deepEqual(inferJunctionConnectivity(input), {
    ok: false,
    code: "junction.manifest.asymmetric",
    reason: "link shop.api->shop.db references endpoint missing from one member Yard"
  });
});

test("no common legal tier fails closed instead of falling through to public", () => {
  const input = fixturePair({
    tierCapabilities: [
      {
        sourceYardId: "yard-aws-prod",
        targetYardId: "yard-azure-prod",
        supportedTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    ]
  });

  assert.deepEqual(inferJunctionConnectivity(input), {
    ok: false,
    code: "junction.tier.unresolvable",
    reason: "link shop.api->shop.db has no supported tier at or better than required tier 3"
  });
});

test("tier precedence selects the most private supported tier within manifest intent", () => {
  const input = fixturePair({
    requiredTier: ConnectivityTier.PUBLIC_MTLS,
    tierCapabilities: [
      {
        sourceYardId: "yard-aws-prod",
        targetYardId: "yard-azure-prod",
        supportedTiers: [
          ConnectivityTier.OVERLAY_MESH,
          ConnectivityTier.PUBLIC_MTLS
        ]
      }
    ]
  });

  const result = inferJunctionConnectivity(input);

  assert.equal(result.ok, true);
  assert.equal(result.inference.edges[0].tier, ConnectivityTier.OVERLAY_MESH);
});

test("public mTLS is selected only when manifest intent permits it", () => {
  const input = fixturePair({
    requiredTier: ConnectivityTier.PUBLIC_MTLS,
    tierCapabilities: [
      {
        sourceYardId: "yard-aws-prod",
        targetYardId: "yard-azure-prod",
        supportedTiers: [ConnectivityTier.PUBLIC_MTLS]
      }
    ]
  });

  const result = inferJunctionConnectivity(input);

  assert.equal(result.ok, true);
  assert.equal(result.inference.edges[0].tier, ConnectivityTier.PUBLIC_MTLS);
});

test("mismatched residency tags are explicit conflicts", () => {
  const input = fixturePair({
    targetResidencyTag: "eu-only"
  });

  assert.deepEqual(inferJunctionConnectivity(input), {
    ok: false,
    code: "junction.residency.illegal",
    reason: "link shop.api->shop.db crosses incompatible residency tags us-only -> eu-only"
  });
});

test("unsupported tier 1 or 2 links are rejected because the Junction only owns cross-Yard tiers", () => {
  const input = fixturePair({
    requiredTier: ConnectivityTier.SAME_PROVIDER_REGION,
    tierCapabilities: [
      {
        sourceYardId: "yard-aws-prod",
        targetYardId: "yard-azure-prod",
        supportedTiers: [ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT]
      }
    ]
  });

  assert.deepEqual(inferJunctionConnectivity(input), {
    ok: false,
    code: "junction.tier.unsupported",
    reason: "link shop.api->shop.db must require cross-Yard tier 3, 4, or 5"
  });
});

test("tampered half projection fails the completeness property check", () => {
  const result = inferJunctionConnectivity(fixturePair());
  assert.equal(result.ok, true);

  const tampered = {
    ...result.inference,
    halvesByYard: {
      "yard-aws-prod": result.inference.halvesByYard["yard-aws-prod"]
    }
  };

  assert.deepEqual(validateInference(tampered), {
    ok: false,
    code: "junction.halves.incomplete",
    reason: "halvesByYard must contain exactly the two mirrored halves for each inferred edge"
  });
});

test("tampered mirrored half fields fail the soundness property check", () => {
  const result = inferJunctionConnectivity(fixturePair());
  assert.equal(result.ok, true);

  const tamperedSourceHalf = {
    ...result.inference.edges[0].halves[0],
    peerResourceId: "shop.unrelated"
  };
  const tampered = {
    ...result.inference,
    edges: [
      {
        ...result.inference.edges[0],
        halves: [tamperedSourceHalf, result.inference.edges[0].halves[1]]
      }
    ],
    halvesByYard: {
      ...result.inference.halvesByYard,
      "yard-aws-prod": [tamperedSourceHalf]
    }
  };

  assert.deepEqual(validateInference(tampered), {
    ok: false,
    code: "junction.edge.halves",
    reason: "edge yard-aws-prod:shop.api->yard-azure-prod:shop.db source half must mirror the inferred endpoint"
  });
});

function* generatedPairs() {
  const providers = [
    ["aws", "us-east-1"],
    ["azure", "eastus"],
    ["gcp", "us-central1"]
  ];
  const tiers = [
    ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    ConnectivityTier.OVERLAY_MESH,
    ConnectivityTier.PUBLIC_MTLS
  ];

  for (const [sourceProvider, sourceRegion] of providers) {
    for (const [targetProvider, targetRegion] of providers) {
      if (sourceProvider === targetProvider) continue;
      for (const tier of tiers) {
        yield fixturePair({
          sourceProvider,
          sourceRegion,
          targetProvider,
          targetRegion,
          requiredTier: tier,
          tierCapabilities: [
            {
              sourceYardId: `yard-${sourceProvider}-prod`,
              targetYardId: `yard-${targetProvider}-prod`,
              supportedTiers: [tier]
            }
          ]
        });
      }
    }
  }
}

function fixturePair(options = {}) {
  const sourceProvider = options.sourceProvider ?? "aws";
  const sourceRegion = options.sourceRegion ?? "us-east-1";
  const targetProvider = options.targetProvider ?? "azure";
  const targetRegion = options.targetRegion ?? "eastus";
  const sourceYardId = `yard-${sourceProvider}-prod`;
  const targetYardId = `yard-${targetProvider}-prod`;
  const requiredTier = options.requiredTier ?? ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT;
  const sourceResidencyTag = options.sourceResidencyTag ?? "us-only";
  const targetResidencyTag = options.targetResidencyTag ?? sourceResidencyTag;

  return {
    junctionId: `junction-${sourceProvider}-${targetProvider}`,
    members: [
      {
        manifest: projectYardManifest(yardTopology({
          yardId: sourceYardId,
          provider: sourceProvider,
          region: sourceRegion,
          resourceId: "shop.api",
          logicalName: "shop.api",
          dnsName: `api.${sourceProvider}.shop.internal`,
          residencyTag: sourceResidencyTag,
          crossYardLinks: [
            {
              id: "shop.api->shop.db",
              bindleId: "shop",
              source: {
                yardId: sourceYardId,
                resourceId: "shop.api",
                endpoint: "shop.api",
                residencyTag: sourceResidencyTag
              },
              target: {
                yardId: targetYardId,
                resourceId: "shop.db",
                endpoint: "shop.db",
                residencyTag: targetResidencyTag
              },
              requiredTier,
              dnsRules: [
                {
                  recordName: "db.internal.shop.com",
                  type: "CNAME",
                  targets: [`shop-db.${targetProvider}.internal`]
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
          provider: targetProvider,
          region: targetRegion,
          resourceId: "shop.db",
          logicalName: "shop.db",
          dnsName: `db.${targetProvider}.shop.internal`,
          residencyTag: targetResidencyTag,
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
      junctionId: `junction-${provider}`
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
