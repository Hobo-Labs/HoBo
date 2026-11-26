import { MULTI_CLOUD_SHOP_FIXTURE } from "../../../../technical-proofs/multi-cloud-shop-provider-e2e-contract/src/multi-cloud-shop-gate.ts";
import { type JsonObject } from "./json.js";


export const MULTI_CLOUD_SHOP_BINDLE = MULTI_CLOUD_SHOP_FIXTURE;

type EventEnvelope = {
  readonly seq: number;
  readonly id: string;
  readonly type: string;
  readonly correlationId: string;
  readonly data: JsonObject;
};

function event(
  seq: number,
  type: string,
  correlationId: string,
  data: JsonObject,
): EventEnvelope {
  return {
    seq,
    id: `evt-${seq}`,
    type,
    correlationId,
    data,
  };
}

export function createMultiCloudShopProjectionEvents(): readonly EventEnvelope[] {
  const deployCorrelation = "deploy:multi-cloud-shop:prod:001";
  const runCorrelation = "run:multi-cloud-shop:prod:001";

  return Object.freeze([
    event(1, "deployment.Planned", deployCorrelation, {
      deploymentId: deployCorrelation,
      bindle: MULTI_CLOUD_SHOP_BINDLE,
      plan: {
        nodes: [
          { id: "orders", deps: [] },
          { id: "assets", deps: [] },
          { id: "api", deps: ["orders", "assets"] },
          { id: "frontend", deps: ["api"] },
        ],
        estimatedMonthlyUsd: 412.5,
      },
    }),
    event(2, "match.Decided", deployCorrelation, {
      resourceId: "orders",
      provider: "aws",
      capability: "postgres",
      reason: "mapping rule prefers aws.rds for orders",
    }),
    event(3, "topology.ResourceResolved", deployCorrelation, {
      id: "orders",
      kind: "postgres",
      provider: "aws",
      region: "us-east-1",
    }),
    event(4, "topology.ResourceResolved", deployCorrelation, {
      id: "assets",
      kind: "object-storage",
      provider: "aws",
      region: "us-east-1",
    }),
    event(5, "topology.ResourceResolved", deployCorrelation, {
      id: "api",
      kind: "http-service",
      provider: "aws",
      region: "us-east-1",
    }),
    event(6, "topology.ResourceResolved", deployCorrelation, {
      id: "frontend",
      kind: "http-service",
      provider: "aws",
      region: "us-east-1",
    }),
    event(7, "topology.BindEdge", deployCorrelation, {
      from: "api",
      to: "orders",
      capability: "postgres",
      tier: "private-link",
      estimatedEgressUsd: 18.4,
    }),
    event(8, "topology.BindEdge", deployCorrelation, {
      from: "api",
      to: "assets",
      capability: "object-storage",
      tier: "regional",
      estimatedEgressUsd: 6.2,
    }),
    event(9, "topology.BindEdge", deployCorrelation, {
      from: "frontend",
      to: "api",
      capability: "http",
      tier: "same-vpc",
      estimatedEgressUsd: 0,
    }),
    event(10, "deployment.ResourceState", deployCorrelation, {
      deploymentId: deployCorrelation,
      resourceId: "orders",
      state: "provisioned",
    }),
    event(11, "deployment.ResourceState", deployCorrelation, {
      deploymentId: deployCorrelation,
      resourceId: "api",
      state: "provisioned",
    }),
    event(12, "deployment.Completed", deployCorrelation, {
      deploymentId: deployCorrelation,
      status: "deployed",
    }),
    event(13, "run.Started", runCorrelation, { runId: runCorrelation }),
    event(14, "run.StepCompleted", runCorrelation, {
      runId: runCorrelation,
      name: "plan",
      attempts: 1,
      durationMs: 24,
      outputDigest: "digest-apply-v1",
    }),
    event(15, "run.StepCompleted", runCorrelation, {
      runId: runCorrelation,
      name: "apply",
      attempts: 1,
      durationMs: 1820,
      outputDigest: "digest-apply-v1",
    }),
    event(16, "run.Completed", runCorrelation, { runId: runCorrelation }),
    event(17, "registry.ProviderPublished", deployCorrelation, {
      providerId: "aws",
      capabilityManifestVersion: "2026.03",
      forgeCertification: "certified",
      provenanceDigest: "forge-provenance-aws-v3",
    }),
    event(18, "credential.Granted", deployCorrelation, {
      principal: "agent:deploy-bot",
      scope: "camp:prod:deploy",
      tokenId: "tok-grant-001",
      runId: runCorrelation,
    }),
    event(19, "credential.Used", deployCorrelation, {
      principal: "agent:deploy-bot",
      tokenId: "tok-grant-001",
      action: "deployment.up",
      runId: runCorrelation,
    }),
    event(20, "policy.GateOpened", deployCorrelation, {
      gateId: "gate-prod-over-budget",
      action: "deployment.up",
      status: "approved",
      approver: "platform-operator",
    }),
    event(21, "cost.Metered", deployCorrelation, {
      tenantId: "tenant-acme",
      bindle: MULTI_CLOUD_SHOP_BINDLE,
      projectedMonthlyUsd: 412.5,
      actualMonthlyUsd: 389.1,
      budgetCapUsd: 500,
      showbackLabel: "tenant-acme/multi-cloud-shop/prod",
    }),
    event(22, "drift.Detected", deployCorrelation, {
      resourceId: "api",
      desired: "replicas:2",
      observed: "replicas:3",
      severity: "medium",
      healAction: "propose-scale-down",
    }),
    event(23, "stream.LogLine", deployCorrelation, {
      streamId: "logs:api",
      timestamp: "2026-07-02T00:10:01.000Z",
      level: "info",
      message: "api ready on camp prod",
    }),
    event(24, "stream.RunEvent", deployCorrelation, {
      streamId: "runs:multi-cloud-shop",
      runId: runCorrelation,
      step: "apply",
      status: "completed",
    }),
  ]);
}
