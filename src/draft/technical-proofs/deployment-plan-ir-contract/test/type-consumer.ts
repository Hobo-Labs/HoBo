import type { DeploymentPlan, MatchContext, ResourcePlan, ValidationResult } from "@hobo/draft-deployment-plan-ir-contract";
import { DEPLOYMENT_PLAN_IR_VERSION, outputPlaceholder } from "@hobo/draft-deployment-plan-ir-contract";

const context: MatchContext = {
  envType: "ephemeral",
  app: "gallery",
  env: "preview",
  tenant: "tenant-acme",
  resourceType: "objectStore",
  resourceClass: "standard",
  resourceId: "assets"
};

const resource: ResourcePlan = {
  id: "assets",
  name: "assets",
  port: {
    interface: "wasi:blobstore/blobstore",
    type: "objectStore",
    className: "standard"
  },
  provider: {
    id: "aws",
    definitionId: "aws-s3-ephemeral",
    driver: "terraform"
  },
  context,
  options: {
    bucketName: outputPlaceholder({
      type: "objectStore",
      className: "standard",
      id: "assets",
      output: "bucketName"
    })
  },
  deps: [],
  strategy: "reconcile",
  replication: "single-region",
  workloadProfile: "managed-resource",
  outputs: ["bucketName"]
};

export const plan: DeploymentPlan = {
  apiVersion: DEPLOYMENT_PLAN_IR_VERSION,
  deploymentId: "deploy-gallery-preview",
  resources: [resource],
  edges: [],
  meta: {
    objective: "cost",
    provenance: {
      sourceManifestHash: "sha256:1111111111111111111111111111111111111111111111111111111111111111",
      catalogContentHash: "sha256:2222222222222222222222222222222222222222222222222222222222222222",
      matchDecisionIds: ["match-assets"]
    }
  }
};

export const validation: ValidationResult = {
  ok: true,
  errors: []
};
