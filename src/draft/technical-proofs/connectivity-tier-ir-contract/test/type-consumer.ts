import {
  ConnectivityTier,
  type ConnectivityPlan,
  type ConnectivityPolicy,
  validateConnectivityPlan
} from "@hobo/draft-connectivity-tier-ir-contract";

const policy: ConnectivityPolicy = {
  maxTier: ConnectivityTier.OVERLAY_MESH,
  allowPublicMtls: false
};

const plan: ConnectivityPlan = {
  schemaVersion: "hobo.connectivity-plan/v1",
  edgeId: "shop.api->shop.db",
  source: {
    resourceId: "shop.api",
    provider: "aws",
    region: "us-east-1",
    yardId: "yard-aws"
  },
  target: {
    resourceId: "shop.db",
    provider: "gcp",
    region: "us-central1",
    yardId: "yard-gcp"
  },
  tier: ConnectivityTier.OVERLAY_MESH,
  endpoints: {
    sourceLogicalName: "ctx.bindings.db",
    targetLogicalName: "shop.db"
  },
  identity: {
    source: "spiffe://tenant-acme/shop/api",
    target: "spiffe://tenant-acme/shop/db"
  },
  parameters: {
    meshKind: "wireguard-ebpf",
    meshPolicyRef: "mesh-shop"
  },
  residency: {
    tag: "us-only"
  },
  policy
};

const validation = validateConnectivityPlan(plan);
if (validation.ok === false) {
  throw new Error(validation.reason);
}

void validateConnectivityPlan({
  schemaVersion: "hobo.connectivity-plan/v1",
  tier: 0
});
