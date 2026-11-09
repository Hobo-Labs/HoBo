import { type JsonValue, type JsonObject } from "./json.js";
export type PlannerObjective = "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits";

export interface MatchContext {
  envType: string;
  app: string;
  env: string;
  tenant: string;
  resourceType: string;
  resourceClass: string;
  resourceId: string;
}

export interface ResourcePlan {
  id: string;
  name: string;
  port: {
    interface: string;
    type: string;
    className: string;
  };
  provider: {
    id: string;
    definitionId: string;
    driver: string;
  };
  context: MatchContext;
  options: JsonObject;
  deps: string[];
  strategy: string;
  replication: string;
  workloadProfile: string;
  outputs: string[];
  coProvisionedFor?: string;
  inputs?: JsonObject;
}

export interface DeploymentPlan {
  apiVersion: string;
  deploymentId: string;
  resources: ResourcePlan[];
  edges: Array<{ from: string; to: string; reason: string }>;
  meta: {
    objective: PlannerObjective;
    provenance: {
      sourceManifestHash: string;
      catalogContentHash: string;
      matchDecisionIds: string[];
    };
  };
}

export interface ValidationResult {
  ok: boolean;
  errors: string[];
}

export declare const DEPLOYMENT_PLAN_IR_VERSION: "hobo.deployment-plan/v1";
export declare function createFixtureDeploymentPlan(): DeploymentPlan;
export declare function canonicalJson(value: JsonValue): string;
export declare function planContentAddress(plan: DeploymentPlan): string;
export declare function outputPlaceholder(input: {
  type: string;
  className: string;
  id: string;
  output: string;
}): string;
export declare function parsePlaceholder(value: string):
  | { kind: "resource-output"; type: string; className: string; id: string; output: string }
  | { kind: "context"; field: string };
export declare function validateDeploymentPlan(plan: DeploymentPlan | JsonValue): ValidationResult;
