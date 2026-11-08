import { type JsonValue, type JsonObject } from "./json.js";
export declare const CONNECTIVITY_PLAN_SCHEMA_VERSION: "hobo.connectivity-plan/v1";

export declare const ConnectivityTier: Readonly<{
  SAME_PROVIDER_REGION: 1;
  SAME_PROVIDER_CROSS_REGION: 2;
  CROSS_PROVIDER_PRIVATE_INTERCONNECT: 3;
  OVERLAY_MESH: 4;
  PUBLIC_MTLS: 5;
}>;

export type ConnectivityTierValue = typeof ConnectivityTier[keyof typeof ConnectivityTier];

export interface ConnectivityEndpoint {
  resourceId: string;
  provider: string;
  region: string;
  yardId: string;
}

export interface ConnectivityPolicy {
  maxTier: ConnectivityTierValue;
  allowPublicMtls?: boolean;
}

export interface ConnectivityPlan {
  schemaVersion: typeof CONNECTIVITY_PLAN_SCHEMA_VERSION;
  edgeId: string;
  source: ConnectivityEndpoint;
  target: ConnectivityEndpoint;
  tier: ConnectivityTierValue;
  endpoints: {
    sourceLogicalName: string;
    targetLogicalName: string;
  };
  identity: {
    source: string;
    target: string;
  };
  parameters: JsonObject;
  residency?: {
    tag: string;
  };
  policy?: ConnectivityPolicy;
  override?: {
    requestedTier: ConnectivityTierValue;
    reason: string;
  };
}

export interface BindEdge {
  edgeId: string;
  source: ConnectivityEndpoint;
  target: ConnectivityEndpoint;
  endpoints: ConnectivityPlan["endpoints"];
  identity: ConnectivityPlan["identity"];
  availableCapabilities?: string[];
  residency?: ConnectivityPlan["residency"];
  policy?: ConnectivityPolicy;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; code: string; reason: string };

export type ConnectivityTierDecision =
  | { ok: true; plan: ConnectivityPlan }
  | { ok: false; code: string; reason: string };

export declare function validateConnectivityPlan(plan: ConnectivityPlan | JsonValue): ValidationResult;
export declare function roundTripConnectivityPlan(plan: ConnectivityPlan): ConnectivityPlan;
export declare function decideConnectivityTier(edge: BindEdge): ConnectivityTierDecision;
export declare function rejectPolicyWideningOverride(plan: Pick<ConnectivityPlan, "tier" | "policy" | "override">): ValidationResult;
