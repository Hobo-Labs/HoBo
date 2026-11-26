import { type JsonObject } from "./json.js";
export type SubjectKind = "user" | "service" | "agent" | "system";
export type PolicyPhase = "author" | "local" | "test" | "plan" | "apply" | "runtime" | "observe" | "train" | "promote" | "repair";
export type DecisionEffect = "allow" | "allow-degraded" | "deny" | "warn" | "mutate" | "require-approval";

export interface DecisionRequest {
  schema: "hobo.policy-ir/v1";
  subject: {
    kind: SubjectKind;
    id: string;
    roles?: string[];
    scopes?: string[];
    delegatedBy?: string;
  };
  action: string;
  resource: {
    kind: string;
    id: string;
  };
  phase: PolicyPhase;
  context?: JsonObject;
}

export interface Decision {
  schema: "hobo.policy-ir.decision/v1";
  effect: DecisionEffect;
  reason: string;
  violations: string[];
  mutations: string[];
  approvals: string[];
  obligations: Array<{ kind: string; reason: string }>;
  evidence: {
    engine: string;
    inputHash: `sha256:${string}`;
    policyIds: string[];
  };
}

export interface TypescriptRule {
  id: string;
  when(input: { request: DecisionRequest }): boolean;
  decide(input: { request: DecisionRequest }): Partial<Decision> & { effect: DecisionEffect; reason: string };
}

export interface PolicyRuleset {
  schema: "hobo.policy-ruleset/v1";
  id: string;
  version: string;
  rules: TypescriptRule[];
}

export interface PolicyEngineAdapter {
  engineId: string;
  evaluate(request: DecisionRequest, ruleset: PolicyRuleset): Decision;
}

export declare const POLICY_ENGINE_PORT: "hobo:policy-engine/policy-engine@0.1.0";
export declare function compileRulesetContract(ruleset: PolicyRuleset): {
  ok: boolean;
  errors: string[];
  compiled: null | {
    rulesetId: string;
    version: string;
    ruleIds: string[];
  };
};
export declare function createBuiltInPolicyEngine(): PolicyEngineAdapter;
export declare function evaluatePolicy(engine: PolicyEngineAdapter, request: DecisionRequest, ruleset: PolicyRuleset): Decision;
