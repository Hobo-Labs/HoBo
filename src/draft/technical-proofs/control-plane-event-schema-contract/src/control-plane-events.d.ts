import { type JsonValue } from "./json.js";
export type ControlPlaneEventType =
  | "deployment.Planned"
  | "deployment.PlanRejected"
  | "match.Decided"
  | "set.Created"
  | "delta.Opened"
  | "delta.Updated"
  | "delta.Applied"
  | "resource.Pending"
  | "resource.Provisioning"
  | "resource.Provisioned"
  | "resource.DriftDetected"
  | "resource.DriftQueued"
  | "resource.Updating"
  | "resource.RefreshFailed"
  | "resource.DriftSuppressed"
  | "resource.Failed"
  | "resource.Destroying"
  | "resource.Destroyed"
  | "resource.Adopted"
  | "exec.Started"
  | "exec.Output"
  | "exec.Succeeded"
  | "exec.Failed"
  | "dispatch.Decided"
  | "deployment.RolledBack"
  | "deployment.Deployed";

export declare const REQUIRED_EVENT_BODY_FIELDS: Record<ControlPlaneEventType, string[]>;
export declare const CORE_EVENT_ENVELOPE_COMPATIBILITY: {
  ref: "@hobo/core/EventEnvelope@v1";
  requiredFields: string[];
};

export interface EventEnvelope<TType extends ControlPlaneEventType, TData> {
  id: string;
  type: TType;
  schemaVersion: number;
  tenant: string;
  seq: number;
  time: string;
  actor: { kind: "user" | "agent" | "service"; id: string };
  correlationId: string;
  causationId: string;
  data: TData;
}

export interface DeploymentPlannedBody {
  plan: JsonValue;
  planHash: string;
}

export interface MatchDecidedBody {
  resourceId: string;
  winner: string;
  ranking: Array<{
    definitionId: string;
    region?: string;
    specificity: number;
    priority: number;
    objectiveScore: number;
    rank: number;
    rationale?: string;
  }>;
  rejectedCandidates: Array<{ definitionId: string; reason: string }>;
  objective: "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits";
  tie: boolean;
  catalogContentHash: string;
}

export interface DispatchDecidedBody {
  dispatchId: string;
  category: "runner" | "build-machine" | string;
  selectedProvider: string;
  objective: "cost" | "latency" | "single-provider" | "carbon" | "maximize-credits";
  ledgerInput: {
    view: "CreditLedgerView";
    seq: number;
    reservationId: string;
    balanceHash: string;
  };
  candidates: Array<{ provider: string; effectiveMarginalCost: number; rationale?: string }>;
}

export interface GenericControlPlaneBody {
  [field: string]: JsonValue;
}

export declare function parseControlPlaneEventWithZod<T extends ControlPlaneEventType>(
  event: EventEnvelope<T, unknown>
): EventEnvelope<T, unknown>;

export declare function roundTripEventThroughProtobuf<T extends ControlPlaneEventType>(
  event: EventEnvelope<T, unknown>,
  protoPath: string
): Promise<EventEnvelope<T, unknown>>;
