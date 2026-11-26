import { type JsonValue, type JsonObject } from "./json.js";
export declare const CONNECTIVITY_POLICY_ENFORCEMENT_SCHEMA_VERSION = "hobo.connectivity-policy-enforcement/v1";

export declare function normalizeConnectivityTier(value: JsonValue): number | undefined;

export declare function enforceConnectivityCanDeploy(input: {
  plan: JsonObject;
  environment: string;
  policyDecision: PolicyDecision;
}): EnforcementResult;

export declare function gateRuntimeResidencyRead(input: {
  stream: ResidencyStream;
  topologySnapshot: { seq: number; camps?: Record<string, { region: string }> };
  policyDecision: PolicyDecision;
}): EnforcementResult;

export interface PolicyDecision {
  decisionId: string;
  phase: "can-deploy" | "runtime";
  effect: "allow" | "deny";
  reason?: string;
  constraints?: {
    maxTier?: number | string;
    forbiddenTiers?: Array<number | string>;
  };
  obligations?: Array<{ type: string; region?: string }>;
  evidence?: {
    policyIds?: string[];
    topologySeq?: number;
  };
}

export interface ResidencyStream {
  streamId: string;
  sourceCamp: { id: string; region: string };
  targetCamp: { id: string; region: string };
  dataResidency: { tag: string; allowedRegions: string[] };
}

export type EnforcementResult =
  | {
      ok: true;
      mode?: "allowed" | "region-pinned";
      request: JsonObject;
      route?: JsonObject;
      enforcementEvent: JsonObject;
    }
  | {
      ok: false;
      code: string;
      reason?: string;
      request?: JsonObject;
      enforcementEvent?: JsonObject;
    };
