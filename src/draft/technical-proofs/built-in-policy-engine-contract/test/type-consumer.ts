import type {
  DecisionRequest,
  TypescriptRule,
} from "../src/built-in-policy-engine.d.mts";
import type * as BuiltInPolicyEngine from "../src/built-in-policy-engine.d.mts";

declare const BUILT_IN_POLICY_ENGINE_ID: typeof BuiltInPolicyEngine.BUILT_IN_POLICY_ENGINE_ID;
declare const createBuiltInPolicyEngine: typeof BuiltInPolicyEngine.createBuiltInPolicyEngine;
declare const createRuleset: typeof BuiltInPolicyEngine.createRuleset;
declare const defineTypescriptRule: typeof BuiltInPolicyEngine.defineTypescriptRule;
declare const evaluatePolicy: typeof BuiltInPolicyEngine.evaluatePolicy;

const rule: TypescriptRule = defineTypescriptRule({
  id: "typed-allow-plan",
  when: ({ request }: { request: DecisionRequest }) =>
    request.action === "hobo:deployment:apply" && request.phase === "plan",
  decide: () => ({ effect: "allow", reason: "typed plan rule matched" }),
});

const request: DecisionRequest = {
  schemaVersion: "hobo.policy-ir/v1",
  subject: {
    kind: "agent",
    id: "spiffe://tenant-a/yard/prod/agent/deployer",
  },
  action: "hobo:deployment:apply",
  resource: {
    kind: "deployment",
    id: "deployment:checkout-prod",
  },
  phase: "plan",
  context: {},
  inputHash: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
};

const engine = createBuiltInPolicyEngine();
const decision = evaluatePolicy(
  engine,
  request,
  createRuleset({ rules: [rule] }),
);

BUILT_IN_POLICY_ENGINE_ID satisfies string;
decision.effect satisfies "allow" | "allow-degraded" | "deny" | "warn" | "mutate" | "require-approval";
decision.evidence.inputHash satisfies `sha256:${string}`;
