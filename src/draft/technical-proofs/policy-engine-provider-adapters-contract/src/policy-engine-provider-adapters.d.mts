import type {
  Decision,
  DecisionRequest,
  Effect,
} from "../../hobo-policy-ir-contract/src/policy-ir.d.mts";
import type {
  BuiltInPolicyEngine,
  PolicyRuleset as BuiltInPolicyRuleset,
  TypescriptRule,
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.d.mts";
import { type JsonValue, type JsonObject } from "./json.js";


export const OPA_REGO_POLICY_ENGINE_ID: "hobo.policy-engine/provider-opa-rego@0.1.0";
export const CEDAR_POLICY_ENGINE_ID: "hobo.policy-engine/provider-cedar@0.1.0";
export const OPA_REGO_EXECUTION_MODE: "opa-rego-wasm";
export const CEDAR_EXECUTION_MODE: "cedar-abac";

export interface OpaInput {
  schemaVersion: "hobo.policy-ir/v1";
  tuple: string;
  subject: DecisionRequest["subject"];
  action: string;
  resource: DecisionRequest["resource"];
  phase: DecisionRequest["phase"];
  context: JsonObject;
}

export interface CedarAuthorizationRequest {
  principal: {
    type: DecisionRequest["subject"]["kind"];
    id: string;
    roles: string[];
    scopes: string[];
    delegatedBy?: DecisionRequest["subject"]["delegatedBy"];
  };
  action: {
    id: string;
  };
  resource: {
    type: string;
    id: string;
  };
  context: JsonObject & {
    phase: DecisionRequest["phase"];
    tuple: string;
  };
}

export interface AdapterPolicyDecision {
  effect: Effect;
  reason: string;
  violations?: JsonValue[];
  mutations?: JsonValue[];
  approvals?: JsonValue[];
  obligations?: Array<{ kind: string; [key: string]: JsonValue }>;
}

export interface OpaRegoPolicy {
  dialect: "opa-rego";
  id: string;
  match(context: { input: OpaInput; request: DecisionRequest }): boolean;
  decide(context: { input: OpaInput; request: DecisionRequest }): AdapterPolicyDecision;
}

export interface CedarPolicy {
  dialect: "cedar";
  id: string;
  when(context: { authorization: CedarAuthorizationRequest; request: DecisionRequest }): boolean;
  decide(context: { authorization: CedarAuthorizationRequest; request: DecisionRequest }): AdapterPolicyDecision;
}

export interface PolicyEngineProviderAdapter {
  engineId: string;
  executionMode: typeof OPA_REGO_EXECUTION_MODE | typeof CEDAR_EXECUTION_MODE;
  evaluate(request: JsonValue, ruleset: JsonValue): Decision;
}

export interface PolicyEngineAdapterRuleset extends Omit<BuiltInPolicyRuleset, "rules"> {
  rules: TypescriptRule[];
  opaPolicies: OpaRegoPolicy[];
  cedarPolicies: CedarPolicy[];
}

export interface ConformanceVector {
  name: string;
  request: JsonValue;
  ruleset: JsonValue;
  expectedEffect: Effect;
  expectedReason?: RegExp;
}

export interface ConformanceReport {
  ok: boolean;
  errors: string[];
  engines: Array<{ engineId: string }>;
  vectors: Array<{ name: string }>;
  results: Array<{
    vector: string;
    engineId: string;
    decision: Decision;
  }>;
}

export function mapDecisionRequestToOpaInput(request: JsonValue): OpaInput;
export function mapDecisionRequestToCedarRequest(request: JsonValue): CedarAuthorizationRequest;
export function defineOpaRegoPolicy(policy: {
  id: string;
  match(context: { input: OpaInput; request: DecisionRequest }): boolean;
  decide(context: { input: OpaInput; request: DecisionRequest }): AdapterPolicyDecision;
}): OpaRegoPolicy;
export function defineCedarPolicy(policy: {
  id: string;
  when(context: { authorization: CedarAuthorizationRequest; request: DecisionRequest }): boolean;
  decide(context: { authorization: CedarAuthorizationRequest; request: DecisionRequest }): AdapterPolicyDecision;
}): CedarPolicy;
export function createPolicyEngineAdapterRuleset(input?: {
  id?: string;
  version?: string;
  policyPacks?: JsonValue[];
  rules?: TypescriptRule[];
  opaPolicies?: OpaRegoPolicy[];
  cedarPolicies?: CedarPolicy[];
}): PolicyEngineAdapterRuleset;
export function createOpaRegoPolicyEngineAdapter(input?: { engineId?: string }): PolicyEngineProviderAdapter;
export function createCedarPolicyEngineAdapter(input?: { engineId?: string }): PolicyEngineProviderAdapter;
export function createAdapterConformanceFixture(): {
  engines: [BuiltInPolicyEngine, PolicyEngineProviderAdapter, PolicyEngineProviderAdapter];
  vectors: ConformanceVector[];
};
export function runPolicyEngineAdapterConformance(input?: {
  engines?: Array<BuiltInPolicyEngine | PolicyEngineProviderAdapter | { engineId: string; evaluate(request: JsonValue, ruleset: JsonValue): Decision }>;
  vectors?: ConformanceVector[];
}): ConformanceReport;
export function assertPolicyEngineAdapterConformance(report: ConformanceReport): ConformanceReport;
