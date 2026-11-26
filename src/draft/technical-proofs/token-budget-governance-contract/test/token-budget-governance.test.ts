import assert from "node:assert/strict";
import { test } from "vitest";

import { POLICY_IR_SCHEMA_VERSION } from "../../hobo-policy-ir-contract/src/policy-ir.js";

import { evaluateInferenceTokenBudget } from "../src/token-budget-governance.js";

function decisionRequest(overrides = {}) {
  return {
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: "agent",
      id: "agent:tenant-a/agent-llm",
      delegatedBy: "user:platform-admin",
      roles: ["operator"],
      scopes: ["hobo:inference:invoke"],
    },
    action: "hobo:inference:invoke",
    resource: {
      kind: "model",
      id: "model:gpt-4o",
    },
    phase: "runtime",
    context: {
      owner: {
        tenantId: "tenant-a",
        campId: "camp-prod",
        agentId: "agent-llm",
      },
      actorId: "user:platform-admin",
      ...overrides.context,
    },
    ...overrides,
  };
}

function meteringView({ seq = 10, scopeTokenCounts = {} } = {}) {
  return { seq, scopeTokenCounts };
}

function tokenBudgetPolicy(overrides = {}) {
  return {
    id: "budget:inference/tenant-a/monthly",
    scope: { kind: "tenant", id: "tenant-a" },
    period: "monthly",
    limits: {
      inputTokens: { soft: 900_000, hard: 1_000_000 },
      outputTokens: { soft: 180_000, hard: 200_000 },
      totalTokens: { soft: 1_000_000, hard: 1_100_000 },
    },
    ...overrides,
  };
}

test("soft threshold emits warn obligation without blocking pre-inference gate", () => {
  const result = evaluateInferenceTokenBudget({
    request: decisionRequest(),
    meteringView: meteringView({
      scopeTokenCounts: {
        "tenant:tenant-a": { inputTokens: 850_000, outputTokens: 0, totalTokens: 850_000 },
      },
    }),
    policies: [tokenBudgetPolicy()],
    estimatedTokens: { inputTokens: 60_000, outputTokens: 10_000 },
  });

  assert.equal(result.decision.effect, "allow");
  assert.equal(result.decision.reason, "inference token budget soft limit crossed");
  assert.equal(
    result.decision.obligations.some((o) => o.kind === "inference.token-budget.warn"),
    true,
  );
  assert.equal(
    result.events.some((e) => e.type === "inference.BudgetGateEvaluated" && e.effect === "warn"),
    true,
  );
});

test("hard threshold denies inference before model invocation", () => {
  const result = evaluateInferenceTokenBudget({
    request: decisionRequest(),
    meteringView: meteringView({
      scopeTokenCounts: {
        "tenant:tenant-a": { inputTokens: 980_000, outputTokens: 0, totalTokens: 980_000 },
      },
    }),
    policies: [tokenBudgetPolicy()],
    estimatedTokens: { inputTokens: 30_000, outputTokens: 5_000 },
  });

  assert.equal(result.decision.effect, "deny");
  assert.equal(result.decision.reason, "inference token budget hard limit exceeded");
  assert.match(result.decision.violations.join(" "), /inputTokens projected .* exceeds hard limit/);
  assert.equal(
    result.events.some((e) => e.type === "inference.BudgetGateEvaluated" && e.effect === "deny"),
    true,
  );
  assert.equal(result.events[0].type, "policy.Decided");
});

test("missing scoped inference-token counter fails closed", () => {
  const result = evaluateInferenceTokenBudget({
    request: decisionRequest(),
    meteringView: meteringView({ scopeTokenCounts: {} }),
    policies: [tokenBudgetPolicy()],
    estimatedTokens: { inputTokens: 1_000, outputTokens: 500 },
  });

  assert.equal(result.decision.effect, "deny");
  assert.equal(result.decision.reason, "inference-token budget context missing");
  assert.equal(
    result.events.some((e) => e.type === "inference.BudgetContextMissing"),
    true,
  );
});

test("agent cannot evade cap by splitting spend across sub-scopes", () => {
  const parentPolicy = tokenBudgetPolicy({
    id: "budget:inference/agent-llm/monthly",
    scope: { kind: "agent", id: "agent-llm" },
    limits: {
      inputTokens: { soft: 40_000, hard: 50_000 },
      outputTokens: { soft: 8_000, hard: 10_000 },
      totalTokens: { soft: 45_000, hard: 55_000 },
    },
  });

  const result = evaluateInferenceTokenBudget({
    request: decisionRequest({
      context: {
        owner: { tenantId: "tenant-a", campId: "camp-prod", agentId: "agent-llm" },
        actorId: "user:platform-admin",
        subScopeAttempt: "run:split-a",
      },
    }),
    meteringView: meteringView({
      scopeTokenCounts: {
        "agent:agent-llm": { inputTokens: 48_000, outputTokens: 1_000, totalTokens: 49_000 },
        "run:split-a": { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    }),
    policies: [parentPolicy],
    estimatedTokens: { inputTokens: 5_000, outputTokens: 2_000 },
  });

  assert.equal(result.decision.effect, "deny");
  assert.match(result.decision.violations.join(" "), /totalTokens projected .* exceeds hard limit/);
});

test("inference token budgets are distinct from auth token credential events", () => {
  const result = evaluateInferenceTokenBudget({
    request: decisionRequest({ action: "hobo:inference:invoke" }),
    meteringView: meteringView({
      scopeTokenCounts: {
        "tenant:tenant-a": { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      },
    }),
    policies: [tokenBudgetPolicy()],
    estimatedTokens: { inputTokens: 100, outputTokens: 50 },
  });

  assert.equal(result.decision.effect, "allow");
  assert.equal(
    result.events.every((event) => !String(event.type).startsWith("token.")),
    true,
    "inference budget gate must not emit auth token.* credential events",
  );
  assert.equal(
    result.events.some((e) => e.type === "inference.BudgetGateEvaluated" || e.type === "policy.Decided"),
    true,
  );
});

test("hard crossing with requireApprovalOnHard routes through approval gate", () => {
  const result = evaluateInferenceTokenBudget({
    request: decisionRequest(),
    meteringView: meteringView({
      scopeTokenCounts: {
        "tenant:tenant-a": { inputTokens: 995_000, outputTokens: 0, totalTokens: 995_000 },
      },
    }),
    policies: [tokenBudgetPolicy({ requireApprovalOnHard: true })],
    estimatedTokens: { inputTokens: 10_000, outputTokens: 1_000 },
  });

  assert.equal(result.decision.effect, "require-approval");
  assert.equal(result.decision.approvals[0].kind, "inference.token-budget");

  const approved = evaluateInferenceTokenBudget({
    request: decisionRequest(),
    meteringView: meteringView({
      scopeTokenCounts: {
        "tenant:tenant-a": { inputTokens: 995_000, outputTokens: 0, totalTokens: 995_000 },
      },
    }),
    policies: [tokenBudgetPolicy({ requireApprovalOnHard: true })],
    estimatedTokens: { inputTokens: 10_000, outputTokens: 1_000 },
    approval: { decision: "approved", approverId: "user:finops-lead" },
  });

  assert.equal(approved.decision.effect, "allow");
});
