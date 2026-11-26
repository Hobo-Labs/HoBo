import {
  POLICY_IR_SCHEMA_VERSION,
  createDecision,
  createDecisionRequest,
  parsePolicyIrDocument,
  type Decision,
  type DecisionRequest,
  type Effect,
  type Phase,
} from "../../src/policy-ir.js";

const request: DecisionRequest = createDecisionRequest({
  schemaVersion: POLICY_IR_SCHEMA_VERSION,
  subject: { kind: "agent", id: "agent:swe-operator" },
  action: "deployment.apply",
  resource: { kind: "deployment", id: "dep:checkout" },
  phase: "apply",
  context: {},
});

const decision: Decision = createDecision(request, {
  effect: "allow" satisfies Effect,
  reason: "type fixture",
  evidence: { policyIds: ["policy:type-fixture"], engine: "typecheck" },
});

const parsed = parsePolicyIrDocument(JSON.stringify({ request, decision }));
const phase: Phase = parsed.request.phase;
const inputHash: `sha256:${string}` = parsed.decision.evidence.inputHash;

// @ts-expect-error unknown effects must fail at compile time.
const badEffect: Effect = "super-allow";

// @ts-expect-error unknown phases must fail at compile time.
const badPhase: Phase = "superuser";

void [phase, inputHash, badEffect, badPhase];
