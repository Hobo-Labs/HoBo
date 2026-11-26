import type { DeploymentPlan } from "../../deployment-plan-ir-contract/src/deployment-plan-ir.d.js";
import { type JsonObject } from "./json.js";


export type PlannerObjective = "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits";

export interface PlannerContext {
  envType: string;
  app: string;
  env: string;
  tenant: string;
}

export interface ManifestResource {
  type: string;
  port?: string;
  paradigm?: string;
  runtime?: string;
  exports?: string[];
  bind?: string[];
  links?: Array<{ import: string; to: string }>;
  outputs?: string[];
  env?: JsonObject;
  name?: string;
  strategy?: string;
  replication?: string;
}

export interface ManifestIr {
  schema: "hobo.manifest/v1";
  componentHost: {
    kind: string;
    version: string;
  };
  resources: Record<string, ManifestResource> | Array<[string, ManifestResource]>;
}

export interface CoProvisionedResourceSpec {
  id: string;
  name?: string;
  port: {
    interface: string;
    type: string;
    className: string;
  };
  deps?: string[];
  outputs?: string[];
  inputs?: JsonObject;
}

export interface PlannerConfig {
  deploymentId?: string;
  context?: Partial<PlannerContext>;
  objective?: PlannerObjective;
  catalogContentHash?: string;
  coProvisioning?: Record<string, CoProvisionedResourceSpec[]>;
}

export interface PlannerRegistry {
  contentHash?: string | (() => string);
}

export interface PlannerInput {
  manifest: ManifestIr;
  config?: PlannerConfig;
  registry?: PlannerRegistry;
}

export interface PlannedEvent {
  id: string;
  type: "deployment.Planned";
  schemaVersion: 1;
  tenant: string;
  seq: number;
  time: string;
  actor: { kind: "user" | "agent" | "service"; id: string };
  correlationId: string;
  causationId: string;
  data: {
    plan: DeploymentPlan;
    planHash: string;
  };
}

export interface PlannerResult {
  schema: "hobo.planner-dag-skeleton/v1";
  deploymentPlan: DeploymentPlan;
  plannedEvent: PlannedEvent;
  sourceManifestHash: `sha256:${string}`;
}

export declare const PLANNER_DAG_SKELETON_VERSION: "hobo.planner-dag-skeleton/v1";

export declare class PlannerValidationError extends Error {
  name: "PlannerValidationError";
}

export declare function createFixtureManifestIr(): ManifestIr;

export declare function plan(
  manifest: ManifestIr,
  config?: PlannerConfig,
  registry?: PlannerRegistry
): PlannerResult;
