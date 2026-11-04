import type { ConnectivityTierValue } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.d.mts";
import {
  projectYardManifest,
  validateYardManifest,
  type DeclaredYardTopology,
  type YardManifest
} from "@hobo/draft-yard-topology-manifest-contract";

const tier: ConnectivityTierValue = 3;

const topology: DeclaredYardTopology = {
  yard: {
    id: "yard-aws-prod",
    provider: "aws",
    regions: ["us-east-1"],
    junctionId: "junction-shop-prod"
  },
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
      requiredTier: tier,
      dnsRules: [
        {
          recordName: "db.internal.shop.com",
          type: "CNAME",
          targets: ["shop-db.privatelink.azure.internal"]
        }
      ]
    }
  ],
  topologyOverrides: [
    {
      id: "force-overlay-mesh",
      kind: "connectivity-tier",
      linkId: "shop.api->shop.db",
      requiredTier: 4,
      reason: "regulated workload override"
    }
  ]
};

const manifest: YardManifest = projectYardManifest(topology);
const result = validateYardManifest(manifest);

if (!result.ok) {
  throw new Error(result.reason);
}
