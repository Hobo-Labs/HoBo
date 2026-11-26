import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vitest";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  YARD_MANIFEST_SCHEMA_VERSION,
  projectYardManifest,
  validateYardManifest
} from "../src/yard-topology-manifest.js";

test("yard manifest schema validates a two-provider declared topology projection", () => {
  const schema = JSON.parse(readFileSync(new URL("../schema/hobo.yard-manifest.v1.schema.json", import.meta.url), "utf8"));
  const manifest = projectYardManifest(twoProviderTopology());

  assert.equal(schema.$id, "https://hobo.dev/schemas/hobo.yard-manifest.v1.schema.json");
  assert.equal(manifest.schemaVersion, YARD_MANIFEST_SCHEMA_VERSION);
  assert.equal(manifest.yard.provider, "aws");
  assert.deepEqual(manifest.yard.regions, ["us-east-1"]);
  assert.equal(manifest.exposedEndpoints[0].logicalName, "shop.api");
  assert.equal(manifest.crossYardLinks[0].requiredTier, ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT);
  assert.equal(validateYardManifest(manifest).ok, true);
});

test("endpoint outside the Yard provider region is rejected", () => {
  const topology = twoProviderTopology();
  topology.exposedEndpoints[0] = {
    ...topology.exposedEndpoints[0],
    provider: "azure",
    region: "eastus"
  };

  assert.deepEqual(validateYardManifest(projectWithoutHash(topology)), {
    ok: false,
    code: "yard.endpoint.outside-region",
    reason: "endpoint shop.api must stay inside provider aws regions us-east-1"
  });
  assert.throws(() => projectYardManifest(topology), /yard\.endpoint\.outside-region/);
});

test("conflicting topology override and inferred DNS rule surfaces deterministic conflict", () => {
  const topology = {
    ...twoProviderTopology(),
    topologyOverrides: [
      {
        id: "manual-db-record",
        kind: "dns-record",
        recordName: "db.internal.shop.com",
        type: "CNAME",
        targets: ["manual-db.override.example"],
        reason: "operator override"
      }
    ]
  };

  assert.deepEqual(validateYardManifest(projectWithoutHash(topology)), {
    ok: false,
    code: "yard.override.conflict",
    reason: "override manual-db-record conflicts with inferred DNS db.internal.shop.com:CNAME"
  });
  assert.throws(() => projectYardManifest(topology), /yard\.override\.conflict/);
});

test("connectivity tier topology override is typed and link-scoped", () => {
  const topology = {
    ...twoProviderTopology(),
    topologyOverrides: [
      {
        id: "force-overlay-mesh",
        kind: "connectivity-tier",
        linkId: "shop.api->shop.db",
        requiredTier: ConnectivityTier.OVERLAY_MESH,
        reason: "regulated workload override"
      }
    ]
  };

  const manifest = projectYardManifest(topology);

  assert.deepEqual(manifest.topologyOverrides, [
    {
      id: "force-overlay-mesh",
      kind: "connectivity-tier",
      linkId: "shop.api->shop.db",
      requiredTier: ConnectivityTier.OVERLAY_MESH,
      reason: "regulated workload override"
    }
  ]);
  assert.equal(validateYardManifest(manifest).ok, true);
  assert.deepEqual(validateYardManifest({
    ...manifest,
    topologyOverrides: [
      {
        id: "force-overlay-mesh",
        kind: "connectivity-tier",
        linkId: "missing-link",
        requiredTier: ConnectivityTier.OVERLAY_MESH,
        reason: "regulated workload override"
      }
    ]
  }), {
    ok: false,
    code: "yard.override.unknown-link",
    reason: "tier override force-overlay-mesh references unknown link missing-link"
  });
});

test("manifest is a stable pure projection and rejects post-projection mutation", () => {
  const topology = twoProviderTopology();
  Object.defineProperty(topology, "liveNetworkAdapter", {
    get() {
      throw new Error("projection must not read live network adapters");
    }
  });

  const first = projectYardManifest(topology);
  const second = projectYardManifest(twoProviderTopology());

  assert.deepEqual(first, second);
  assert.match(first.contentHash, /^[a-f0-9]{64}$/);

  const tampered = {
    ...first,
    exposedEndpoints: [
      {
        ...first.exposedEndpoints[0],
        dnsName: "changed.aws.shop.com"
      }
    ]
  };

  assert.deepEqual(validateYardManifest(tampered), {
    ok: false,
    code: "yard.manifest.hash-mismatch",
    reason: "contentHash does not match YardManifest content"
  });
});

test("manifest missing provider or residency fields is rejected", () => {
  const manifest = projectYardManifest(twoProviderTopology());

  assert.deepEqual(validateYardManifest({
    ...manifest,
    yard: {
      id: manifest.yard.id,
      regions: manifest.yard.regions
    }
  }), {
    ok: false,
    code: "yard.topology.required-field",
    reason: "yard.provider must be a non-empty string"
  });

  assert.deepEqual(validateYardManifest({
    ...manifest,
    exposedEndpoints: [
      {
        logicalName: "shop.api",
        resourceId: "shop.api",
        campId: "prod-aws",
        provider: "aws",
        region: "us-east-1",
        dnsName: "api.aws.shop.com"
      }
    ]
  }), {
    ok: false,
    code: "yard.topology.required-field",
    reason: "exposedEndpoints.residencyTag must be a non-empty string"
  });
});

function twoProviderTopology() {
  return {
    yard: {
      id: "yard-aws-prod",
      provider: "aws",
      regions: ["us-east-1"],
      junctionId: "junction-shop-prod"
    },
    providerZones: [
      {
        id: "zone-shop-com",
        domain: "shop.com",
        regions: ["us-east-1"]
      }
    ],
    exposedEndpoints: [
      {
        logicalName: "shop.api",
        resourceId: "shop.api",
        campId: "prod-aws",
        provider: "aws",
        region: "us-east-1",
        dnsName: "api.aws.shop.com",
        residencyTag: "us-only"
      }
    ],
    crossYardLinks: [
      {
        id: "shop.api->shop.db",
        bindleId: "shop",
        source: {
          yardId: "yard-aws-prod",
          resourceId: "shop.api",
          endpoint: "shop.api",
          residencyTag: "us-only"
        },
        target: {
          yardId: "yard-azure-prod",
          resourceId: "shop.db",
          endpoint: "shop.db",
          residencyTag: "us-only"
        },
        requiredTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
        dnsRules: [
          {
            recordName: "db.internal.shop.com",
            type: "CNAME",
            targets: ["shop-db.privatelink.azure.internal"]
          }
        ]
      }
    ]
  };
}

function projectWithoutHash(topology) {
  return {
    schemaVersion: YARD_MANIFEST_SCHEMA_VERSION,
    yard: topology.yard,
    providerZones: topology.providerZones ?? [],
    exposedEndpoints: topology.exposedEndpoints ?? [],
    crossYardLinks: topology.crossYardLinks ?? [],
    topologyOverrides: topology.topologyOverrides ?? [],
    contentHash: "0".repeat(64)
  };
}
