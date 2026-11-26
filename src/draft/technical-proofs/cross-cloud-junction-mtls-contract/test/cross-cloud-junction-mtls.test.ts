import assert from "node:assert/strict";
import { test } from "vitest";

import { ConnectivityTier } from "../../connectivity-tier-ir-contract/src/connectivity-tier-ir.js";
import {
  invokeCrossCloudService,
  planCrossCloudJunction
} from "../src/cross-cloud-junction-mtls.js";

test("rejects junction with fewer than two providers", () => {
  const result = planCrossCloudJunction({
    junction: {
      kind: "junction",
      name: "single",
      yards: [{ kind: "yard", name: "aws", providerId: "aws", camps: [] }],
      providerIds: ["aws"]
    },
    bindEdges: [minimalEdge()],
    yardTopologies: [minimalYard("yard-aws-us", "aws")],
    environment: "prod",
    policyDecision: allowPolicy()
  });

  assert.deepEqual(result, {
    ok: false,
    code: "cross-cloud.junction.peers",
    reason: "cross-cloud junction requires at least two peer Yards"
  });
});

test("invoke rejects plan with non-empty sharedStateWrites", () => {
  const fakePlan = {
    ok: true,
    outcome: "deployable",
    edgePlans: [minimalEdgePlan()],
    annotatedEdges: [],
    junctionConnectivity: {
      sharedStateWrites: ["forbidden-write"]
    }
  };

  assert.deepEqual(invokeCrossCloudService({ planResult: fakePlan, mtlsHandshake: minimalMtls() }), {
    ok: false,
    code: "cross-cloud.shared-state.forbidden",
    reason: "Junction must not write shared mutable state"
  });
});

function allowPolicy() {
  return {
    phase: "can-deploy",
    effect: "allow",
    decisionId: "policy-001",
    constraints: { maxTier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT }
  };
}

function minimalEdge() {
  return {
    edgeId: "a->b",
    source: {
      resourceId: "a",
      provider: "aws",
      region: "us-east-1",
      yardId: "yard-aws-us"
    },
    target: {
      resourceId: "b",
      provider: "azure",
      region: "eastus",
      yardId: "yard-azure-eu"
    },
    endpoints: { sourceLogicalName: "a", targetLogicalName: "b" },
    identity: { source: "spiffe://t/a", target: "spiffe://t/b" },
    availableCapabilities: ["private-interconnect"]
  };
}

function minimalEdgePlan() {
  return {
    edgeId: "a->b",
    tier: ConnectivityTier.CROSS_PROVIDER_PRIVATE_INTERCONNECT,
    source: { provider: "aws", yardId: "yard-aws-us", resourceId: "a" },
    target: { provider: "azure", yardId: "yard-azure-eu", resourceId: "b" }
  };
}

function minimalYard(id: string, provider: string) {
  return {
    yard: { id, provider, regions: ["us-east-1"], junctionId: "j" },
    providerZones: [],
    exposedEndpoints: []
  };
}

function minimalMtls() {
  return {
    schemaVersion: "hobo.mtls-data-path/v1",
    connectionId: "a-b",
    tenant: "t",
    trustDomain: "t",
    sourceSvid: "spiffe://t/a",
    peerCertificate: {
      spiffeId: "spiffe://t/b",
      serialNumber: "1",
      notBefore: "2026-06-29T00:00:00.000Z",
      notAfter: "2026-06-29T04:00:00.000Z",
      rotationEpoch: 1
    },
    allowedPeers: ["spiffe://t/b"],
    certMaterialRef: "identity://svid-cert/t/a",
    authz: { bindEdgeId: "a->b", verbs: ["connect"] },
    now: "2026-06-29T01:00:00.000Z"
  };
}
