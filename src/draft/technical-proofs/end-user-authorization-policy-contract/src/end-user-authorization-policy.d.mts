import type {
  Decision,
  DecisionRequest,
} from "../../hobo-policy-ir-contract/src/policy-ir.d.mts";
import type {
  PolicyRuleset,
  TypescriptRule,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.d.mts";
import { type JsonValue, type JsonObject } from "./json.js";


export const USER_AUTHORIZATION_ENGINE_ID: "hobo.policy.user-authorization@0.1.0";

export interface VerifiedUserClaims {
  id: string;
  verified: true;
  roles?: string[];
  scopes?: string[];
  tenantId: string;
}

export interface UserAuthorizationContext {
  user?: VerifiedUserClaims | {
    id?: string;
    verified?: boolean;
    roles?: string[];
    scopes?: string[];
    tenantId?: string;
  };
}

export interface RecordResourceRef {
  kind: string;
  id: string;
}

export interface OwnerClaimRuleInput {
  id: string;
  action: string;
  resourceKind: string;
  ownerField: string;
  tenantField: string;
  requiredScope?: string;
}

export interface AllowShorthand extends OwnerClaimRuleInput {
  authoring: "allow-shorthand";
}

export interface UserAuthorizationResult {
  request: DecisionRequest;
  decision: Decision;
  auditEvent: {
    id: string;
    type: "policy.Decided";
    schemaVersion: "hobo.policy-ir/v1";
    subject: DecisionRequest["subject"];
    action: string;
    resource: DecisionRequest["resource"];
    phase: DecisionRequest["phase"];
    data: Decision;
  };
}

export function createUserAuthorizationRuleset(input?: {
  id?: string;
  version?: string;
  policyPacks?: JsonValue[];
  rules?: TypescriptRule[];
}): PolicyRuleset;
export function allow(input: OwnerClaimRuleInput): AllowShorthand;
export function lowerAllowToUserClaimRule(input: AllowShorthand): TypescriptRule;
export function ownerClaimPolicyRule(input: OwnerClaimRuleInput): TypescriptRule;
export function authorizeUserRecord(input: {
  ctx?: UserAuthorizationContext;
  action: string;
  resource: RecordResourceRef;
  record: JsonObject;
  requestBody?: JsonObject;
  ruleset?: PolicyRuleset;
  phase?: "runtime";
}): UserAuthorizationResult;
