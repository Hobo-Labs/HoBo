import type {
  Decision,
  DecisionRequest,
  Effect,
} from "../../hobo-policy-ir-contract/src/policy-ir.d.mts";
import { type JsonValue } from "./json.js";


export const POLICY_IR_SCHEMA_VERSION: "hobo.policy-ir/v1";
export type {
  Decision,
  DecisionRequest,
  Effect,
} from "../../hobo-policy-ir-contract/src/policy-ir.d.mts";

export const BUILT_IN_POLICY_ENGINE_ID: "hobo.policy-engine/built-in-typescript@0.1.0";
export const POLICY_RULESET_SCHEMA_VERSION: "hobo.policy-ruleset/v1";
export const BUILT_IN_POLICY_ENGINE_EXECUTION_MODE: "yard-local";

export interface TypescriptRuleContext {
  request: DecisionRequest;
}

export interface TypescriptRuleDecision {
  effect: Effect;
  reason: string;
  violations?: JsonValue[];
  mutations?: JsonValue[];
  approvals?: JsonValue[];
  obligations?: Array<{ kind: string; [key: string]: JsonValue }>;
}

export interface TypescriptRule {
  authoring: "typed-typescript-rule";
  id: string;
  when(context: TypescriptRuleContext): boolean;
  decide(context: TypescriptRuleContext): TypescriptRuleDecision;
}

export interface PolicyRuleset {
  schemaVersion: typeof POLICY_RULESET_SCHEMA_VERSION;
  id: string;
  version: string;
  policyPacks: JsonValue[];
  rules: TypescriptRule[];
}

export interface BuiltInPolicyEngine {
  engineId: string;
  executionMode: typeof BUILT_IN_POLICY_ENGINE_EXECUTION_MODE;
  evaluate(request: DecisionRequest, ruleset: PolicyRuleset): Decision;
}

export function createGoldenDecisionRequest(overrides?: Partial<DecisionRequest>): DecisionRequest;
export function defineTypescriptRule(rule: {
  id: string;
  when(context: TypescriptRuleContext): boolean;
  decide(context: TypescriptRuleContext): TypescriptRuleDecision;
}): TypescriptRule;
export function createRuleset(input?: {
  id?: string;
  version?: string;
  policyPacks?: JsonValue[];
  rules?: TypescriptRule[];
}): PolicyRuleset;
export function createBuiltInPolicyEngine(input?: { engineId?: string }): BuiltInPolicyEngine;
export function evaluatePolicy(engine: BuiltInPolicyEngine, request: DecisionRequest, ruleset: PolicyRuleset): Decision;
export function evaluateAndRecordPolicyDecision(input: {
  engine: BuiltInPolicyEngine;
  request: DecisionRequest;
  ruleset: PolicyRuleset;
  auditSink(event: JsonValue): void | Promise<void>;
}): Promise<Decision>;
export function requestTuple(request: DecisionRequest): string;
