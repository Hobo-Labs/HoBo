import { type JsonObject } from "./json.js";
export const POLICY_AUTHORING_SCHEMA_VERSION: "hobo.policy-authoring/v1";
export const POLICY_WAIVER_SCHEMA_VERSION: "hobo.policy-waiver/v1";
export const POLICY_WAIVER_REQUESTED: "policy.WaiverRequested";
export const POLICY_WAIVER_APPROVED: "policy.WaiverApproved";
export const REQUIRED_POLICY_PACK_ACTIONS: readonly [
  "hobo:policy-pack:create",
  "hobo:policy-pack:update",
  "hobo:policy-pack:approve",
];

export type PolicyScope = "junction" | "yard" | "camp" | "bindle";
export type PolicyRuleMode = "mandatory" | "default";
export type PolicyRuleEffect = "deny" | "allow";
export type PolicyPackOperation = "create" | "update";
export type PolicyDecisionEffect = "allow" | "deny";
export type PolicyPackAction =
  | "hobo:policy-pack:create"
  | "hobo:policy-pack:update"
  | "hobo:policy-pack:approve";

export interface PolicyPrincipal {
  kind: string;
  id: string;
  roles?: string[];
  allowedActionIds?: string[];
}

export interface NormalizedPolicyPrincipal {
  kind: string;
  id: string;
  roles: string[];
  allowedActionIds: string[];
}

export interface PolicyTarget {
  resource: "policy-pack" | string;
  resourceId: string;
  verb: "create" | "update" | "approve" | string;
  phase: string;
}

export interface NormalizedPolicyTarget {
  resource: string;
  resourceKind: `hobo:${string}`;
  resourceId: string;
  verb: string;
  phase: string;
  actionId: `hobo:${string}:${string}`;
  tuple: `hobo:${string}:${string}:${string}`;
}

export interface PolicyRuleDraft {
  authoring: "typed-typescript-policy-rule";
  id: string;
  mode: PolicyRuleMode;
  effect: PolicyRuleEffect;
  target: NormalizedPolicyTarget;
  reason: string;
}

export interface CompiledPolicyRule {
  id: string;
  mode: PolicyRuleMode;
  denies: string[];
  allows: string[];
  limits: [];
  reason: string;
  target: NormalizedPolicyTarget;
}

export interface CompiledPolicyPack {
  schema: "hobo.policy-pack/v1";
  schemaVersion: typeof POLICY_AUTHORING_SCHEMA_VERSION;
  id: string;
  scope: PolicyScope;
  version: string;
  authoredBy: NormalizedPolicyPrincipal;
  requiredControlPlaneActions: PolicyPackAction[];
  rules: CompiledPolicyRule[];
}

export interface PolicyPackChange {
  schemaVersion: typeof POLICY_AUTHORING_SCHEMA_VERSION;
  id: string;
  status: "pending-approval";
  operation: PolicyPackOperation;
  pack: CompiledPolicyPack;
  author: NormalizedPolicyPrincipal;
  approverRole: string;
  controlPlaneActions: PolicyPackAction[];
}

export interface ApprovedPolicyPackChange extends Omit<PolicyPackChange, "status"> {
  status: "approved";
  approvedBy: NormalizedPolicyPrincipal;
  approvedAt: string;
}

export interface DeniedResult {
  ok: false;
  code: string;
  reason: string;
}

export interface PolicyWaiverEvent {
  type: typeof POLICY_WAIVER_REQUESTED | typeof POLICY_WAIVER_APPROVED;
  schemaVersion: typeof POLICY_WAIVER_SCHEMA_VERSION;
  occurredAt: string;
  actor: {
    kind: string;
    id: string;
    roles: string[];
  };
  data: JsonObject;
}

export interface RequestedPolicyWaiver {
  schemaVersion: typeof POLICY_WAIVER_SCHEMA_VERSION;
  id: string;
  status: "requested";
  target: NormalizedPolicyTarget;
  requester: NormalizedPolicyPrincipal;
  approverRole: string;
  reason: string;
  requestedAt: string;
  expiresAt: string;
  sourcePolicyIds: string[];
  audit: PolicyWaiverEvent[];
}

export interface ApprovedPolicyWaiver extends Omit<RequestedPolicyWaiver, "status"> {
  status: "approved";
  approvedBy: NormalizedPolicyPrincipal;
  approvedAt: string;
}

export type WaiverRequestResult =
  | { ok: true; waiver: RequestedPolicyWaiver; events: PolicyWaiverEvent[] }
  | DeniedResult;

export type WaiverApprovalResult =
  | { ok: true; waiver: ApprovedPolicyWaiver; events: PolicyWaiverEvent[] }
  | DeniedResult;

export interface PolicyWaiverDecision {
  effect: PolicyDecisionEffect;
  reason: string;
  target: NormalizedPolicyTarget;
  evidence: JsonObject;
}

export function definePolicyRule(input: {
  id: string;
  mode?: PolicyRuleMode;
  effect?: PolicyRuleEffect;
  target: PolicyTarget;
  reason: string;
}): PolicyRuleDraft;

export function compilePolicyPack(input: {
  id: string;
  scope: PolicyScope;
  version: string;
  author: PolicyPrincipal;
  rules: PolicyRuleDraft[];
}): CompiledPolicyPack;

export function proposePolicyPackChange(input: {
  operation: PolicyPackOperation;
  pack: CompiledPolicyPack;
  author: PolicyPrincipal;
  approverRole: string;
}): PolicyPackChange;

export function approvePolicyPackChange(input: {
  change: PolicyPackChange;
  approver: PolicyPrincipal;
  now?: Date | string;
}): { ok: true; change: ApprovedPolicyPackChange } | DeniedResult;

export function requestPolicyWaiver(input: {
  requester: PolicyPrincipal;
  target: PolicyTarget;
  policyPacks: CompiledPolicyPack[];
  approverRole: string;
  reason: string;
  now?: Date | string;
  expiresAt: Date | string;
}): WaiverRequestResult;

export function approvePolicyWaiver(input: {
  waiver: RequestedPolicyWaiver;
  approver: PolicyPrincipal;
  now?: Date | string;
}): WaiverApprovalResult;

export function evaluatePolicyWaiver(input: {
  target: PolicyTarget;
  waiver?: ApprovedPolicyWaiver;
  policyPacks: CompiledPolicyPack[];
  now?: Date | string;
}): PolicyWaiverDecision;
