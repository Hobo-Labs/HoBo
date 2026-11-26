import { type JsonValue, type JsonObject } from "./json.js";
export const POLICY_IR_SCHEMA_VERSION: "hobo.policy-ir/v1";
export const POLICY_DECIDED_EVENT_TYPE: "policy.Decided";
export const SUBJECT_KINDS: readonly ["user", "service", "agent", "system"];
export const PHASES: readonly [
  "author",
  "local",
  "test",
  "plan",
  "apply",
  "runtime",
  "observe",
  "train",
  "promote",
  "repair",
];
export const EFFECTS: readonly [
  "allow",
  "allow-degraded",
  "deny",
  "warn",
  "mutate",
  "require-approval",
];

export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export type Phase = (typeof PHASES)[number];
export type Effect = (typeof EFFECTS)[number];

export interface PrincipalRef {
  kind: SubjectKind;
  id: string;
}

export interface DecisionSubject extends PrincipalRef {
  roles?: string[];
  scopes?: string[];
  delegatedBy?: PrincipalRef | string;
}

export interface DecisionResource {
  kind: string;
  id: string;
}

export interface DecisionRequest {
  schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
  subject: DecisionSubject;
  action: string;
  resource: DecisionResource;
  phase: Phase;
  context: JsonObject;
  inputHash: `sha256:${string}`;
}

export interface DecisionEvidence {
  policyIds: string[];
  inputHash: `sha256:${string}`;
  engine: string;
}

export interface Decision {
  schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
  effect: Effect;
  reason: string;
  violations: JsonValue[];
  mutations: JsonValue[];
  approvals: JsonValue[];
  obligations: Array<{ kind: string; [key: string]: JsonValue }>;
  evidence: DecisionEvidence;
}

export class PolicyIrValidationError extends Error {
  code: string;
  path: string;
}

export function createDecisionRequest<T>(input: T): DecisionRequest;
export function parseDecisionRequest<T>(input: T): DecisionRequest;
export function createDecision<TRequest, TDecision>(requestInput: TRequest, decisionInput: TDecision): Decision;
export function parseDecision<TInput, TRequest>(input: TInput, requestInput?: TRequest): Decision;
export function serializePolicyIrDocument(input: JsonValue): string;
export interface PolicyIrDocument {
  request: DecisionRequest;
  decision: Decision;
}
export function parsePolicyIrDocument(input: JsonValue): PolicyIrDocument;
export function migratePolicyIrDocument(input: JsonValue): DecisionRequest;
export function createPolicyDecidedEvent<TRequest, TDecision>(input: {
  request: TRequest;
  decision: TDecision;
  id?: string;
}): {
  id: string;
  type: typeof POLICY_DECIDED_EVENT_TYPE;
  schemaVersion: typeof POLICY_IR_SCHEMA_VERSION;
  subject: DecisionSubject;
  action: string;
  resource: DecisionResource;
  phase: Phase;
  data: Decision;
};
export interface WitDecisionRecord {
  schema_version: string;
  effect: Effect;
  reason: string;
  violations: JsonValue[];
  mutations: JsonValue[];
  approvals: JsonValue[];
  obligations: Array<{ kind: string; [key: string]: JsonValue }>;
  evidence: {
    policy_ids: string[];
    input_hash: `sha256:${string}`;
    engine: string;
  };
}
export function toWitDecisionRecord(input: JsonValue): WitDecisionRecord;
export function fromWitDecisionRecord(input: JsonValue, requestInput?: JsonValue): Decision;
export function hashDecisionRequest<T>(input: T): `sha256:${string}`;
export function canonicalJson<T>(input: T): string;
