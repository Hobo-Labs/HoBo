import {
  CEDAR_POLICY_ENGINE_ID,
  OPA_REGO_POLICY_ENGINE_ID,
  createCedarPolicyEngineAdapter,
  createOpaRegoPolicyEngineAdapter,
  createPolicyEngineAdapterRuleset,
  defineCedarPolicy,
  defineOpaRegoPolicy,
  mapDecisionRequestToCedarRequest,
  mapDecisionRequestToOpaInput,
  runPolicyEngineAdapterConformance,
} from "@hobo/policy-engine-provider-adapters-contract";

const opa = createOpaRegoPolicyEngineAdapter({ engineId: OPA_REGO_POLICY_ENGINE_ID });
const cedar = createCedarPolicyEngineAdapter({ engineId: CEDAR_POLICY_ENGINE_ID });

const ruleset = createPolicyEngineAdapterRuleset({
  opaPolicies: [
    defineOpaRegoPolicy({
      id: "opa.allow-deployment-plan",
      match: ({ input }) => input.action === "hobo:deployment:apply",
      decide: () => ({ effect: "allow", reason: "typed OPA/Rego consumer" }),
    }),
  ],
  cedarPolicies: [
    defineCedarPolicy({
      id: "cedar.allow-deployment-plan",
      when: ({ authorization }) => authorization.action.id === "hobo:deployment:apply",
      decide: () => ({ effect: "allow", reason: "typed Cedar consumer" }),
    }),
  ],
});

const report = runPolicyEngineAdapterConformance({ engines: [opa, cedar] });

if (!report.ok) {
  throw new Error(report.errors.join("\n"));
}

void ruleset;
void mapDecisionRequestToOpaInput;
void mapDecisionRequestToCedarRequest;
