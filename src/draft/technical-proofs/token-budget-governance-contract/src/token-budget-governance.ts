import { isJsonString, isJsonObject } from "./json.js";
import { createHash } from "node:crypto";
import {

  canonicalJson,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";

export const TOKEN_BUDGET_GOVERNANCE_ENGINE_ID =
  "hobo.token-budget-governance/contract@0.1.0";
export const TOKEN_BUDGET_GOVERNANCE_SCHEMA_VERSION =
  "hobo.token-budget-governance/v1";

const SCOPE_KINDS = new Set(["tenant", "camp", "agent", "model", "run"]);
const PERIODS = new Set(["per-run", "daily", "monthly"]);
const APPROVAL_DECISIONS = new Set(["approved", "denied"]);

export function evaluateInferenceTokenBudget(input) {
  const source = expectObject(input, "input");
  const request = createDecisionRequest(source.request);
  const meteringView = normalizeMeteringView(source.meteringView);
  const policies = normalizePolicies(source.policies);
  const approval = normalizeApproval(source.approval);
  const estimatedTokens = normalizeEstimatedTokens(source.estimatedTokens);

  const state = {
    request,
    meteringView,
    estimatedTokens,
    approval,
    evaluations: [],
    events: [],
    obligations: [],
    approvals: [],
    violations: [],
    missingTokenContext: policies.length === 0 && hasEstimatedSpend(estimatedTokens),
    hardViolations: [],
    approvalDenied: [],
    approvalNeeded: [],
  };

  if (state.missingTokenContext) {
    state.violations.push(
      "missing TokenBudget policy context for inference-incurring action",
    );
    state.events.push(
      createInferenceContextMissingEvent({ request, meteringView, estimatedTokens }),
    );
  }

  for (const policy of policies) {
    evaluatePolicy(state, policy);
  }

  const decision = createDecision(request, {
    effect: chooseEffect(state),
    reason: chooseReason(state),
    violations: state.violations,
    approvals: state.approvals,
    obligations: state.obligations,
    evidence: {
      engine: TOKEN_BUDGET_GOVERNANCE_ENGINE_ID,
      policyIds: policies.map((policy) => policy.id),
    },
  });

  const policyEvent = createAuditedPolicyEvent({
    request,
    decision,
    meteringView,
    estimatedTokens,
    actorId: readActorId(request),
    approverId: approval?.approverId ?? null,
    policyIds: policies.map((policy) => policy.id),
  });

  return {
    schemaVersion: TOKEN_BUDGET_GOVERNANCE_SCHEMA_VERSION,
    request,
    decision,
    events: [policyEvent, ...state.events],
    evaluations: state.evaluations,
  };
}

function evaluatePolicy(state, policy) {
  const scopeTokens = readScopeTokens(state.meteringView, policy.scope);
  const projected = projectTokens(scopeTokens, state.estimatedTokens);
  const evaluation = {
    policyId: policy.id,
    scope: policy.scope,
    period: policy.period,
    current: scopeTokens,
    estimated: state.estimatedTokens,
    projected,
    meteringViewSeq: state.meteringView.seq,
  };
  state.evaluations.push(evaluation);

  if (!scopeTokens.found && hasEstimatedSpend(state.estimatedTokens)) {
    state.missingTokenContext = true;
    state.violations.push(
      `${policy.id}: missing MeteringView inference-token counter for ${policy.scope.kind}:${policy.scope.id}`,
    );
    state.events.push(
      createInferenceContextMissingEvent({
        request: state.request,
        meteringView: state.meteringView,
        estimatedTokens: state.estimatedTokens,
        policyId: policy.id,
        scope: policy.scope,
      }),
    );
    return;
  }

  const axisViolations = evaluateAxes(state, policy, projected);
  if (axisViolations.hard.length > 0) {
    state.hardViolations.push(...axisViolations.hard);
    state.violations.push(...axisViolations.hard);
    state.events.push(
      createBudgetGateEvent({
        request: state.request,
        policy,
        projected,
        effect: "deny",
        meteringViewSeq: state.meteringView.seq,
      }),
    );
    if (policy.requireApprovalOnHard) {
      state.approvalNeeded.push(policy.id);
    }
    return;
  }

  if (axisViolations.soft.length > 0) {
    state.obligations.push({
      kind: "inference.token-budget.warn",
      policyId: policy.id,
      axes: axisViolations.soft,
    });
    state.events.push(
      createBudgetGateEvent({
        request: state.request,
        policy,
        projected,
        effect: "warn",
        meteringViewSeq: state.meteringView.seq,
      }),
    );
  }
}

function evaluateAxes(state, policy, projected) {
  const soft = [];
  const hard = [];
  for (const axis of ["inputTokens", "outputTokens", "totalTokens"]) {
    const limits = policy.limits?.[axis];
    if (!limits) continue;
    const value = projected[axis];
    if (limits.hard !== undefined && value > limits.hard) {
      hard.push(`${axis} projected ${value} exceeds hard limit ${limits.hard}`);
    } else if (limits.soft !== undefined && value > limits.soft) {
      soft.push(`${axis} projected ${value} exceeds soft limit ${limits.soft}`);
    }
  }
  return { soft, hard };
}

function chooseEffect(state) {
  if (state.missingTokenContext || state.hardViolations.length > 0) {
    if (state.approvalNeeded.length > 0) {
      if (state.approval?.decision === "approved") {
        return "allow";
      }
      if (state.approval?.decision === "denied") {
        return "deny";
      }
      state.approvals.push({
        kind: "inference.token-budget",
        policyIds: state.approvalNeeded,
      });
      return "require-approval";
    }
    return "deny";
  }
  if (state.approval?.decision === "denied") {
    return "deny";
  }
  return "allow";
}

function chooseReason(state) {
  if (state.missingTokenContext) {
    return "inference-token budget context missing";
  }
  if (state.hardViolations.length > 0) {
    return "inference token budget hard limit exceeded";
  }
  if (state.obligations.length > 0) {
    return "inference token budget soft limit crossed";
  }
  return "within inference token budget";
}

function projectTokens(scopeTokens, estimatedTokens) {
  return {
    inputTokens: scopeTokens.inputTokens + estimatedTokens.inputTokens,
    outputTokens: scopeTokens.outputTokens + estimatedTokens.outputTokens,
    totalTokens:
      scopeTokens.inputTokens +
      scopeTokens.outputTokens +
      estimatedTokens.inputTokens +
      estimatedTokens.outputTokens,
  };
}

function readScopeTokens(meteringView, scope) {
  const key = `${scope.kind}:${scope.id}`;
  const entry = meteringView.scopeTokenCounts?.[key];
  if (!entry) {
    return { found: false, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
  }
  const inputTokens = entry.inputTokens ?? 0;
  const outputTokens = entry.outputTokens ?? 0;
  return {
    found: true,
    inputTokens,
    outputTokens,
    totalTokens: entry.totalTokens ?? inputTokens + outputTokens,
  };
}

function createAuditedPolicyEvent({
  request,
  decision,
  meteringView,
  estimatedTokens,
  actorId,
  approverId,
  policyIds,
}) {
  return createPolicyDecidedEvent({
    request,
    decision,
    metadata: {
      engine: TOKEN_BUDGET_GOVERNANCE_ENGINE_ID,
      meteringViewSeq: meteringView.seq,
      estimatedTokens,
      actorId,
      approverId,
      policyIds,
    },
  });
}

function createBudgetGateEvent({ request, policy, projected, effect, meteringViewSeq }) {
  return {
    type: "inference.BudgetGateEvaluated",
    seq: meteringViewSeq + 1,
    policyId: policy.id,
    scope: policy.scope,
    effect,
    projected,
    meteringViewSeq,
    subject: request.subject?.id ?? null,
    action: request.action,
    digest: digest({
      policyId: policy.id,
      effect,
      projected,
      meteringViewSeq,
    }),
  };
}

function createInferenceContextMissingEvent({
  request,
  meteringView,
  estimatedTokens,
  policyId = null,
  scope = null,
}) {
  return {
    type: "inference.BudgetContextMissing",
    seq: meteringView.seq + 1,
    policyId,
    scope,
    estimatedTokens,
    subject: request.subject?.id ?? null,
    action: request.action,
    meteringViewSeq: meteringView.seq,
  };
}

function normalizeMeteringView(value) {
  const source = expectObject(value, "meteringView");
  return {
    seq: requireNonNegativeInteger(source.seq, "meteringView.seq"),
    scopeTokenCounts: source.scopeTokenCounts ,
  };
}

function normalizePolicies(value) {
  const policies = expectArray(value ?? [], "policies");
  return policies.map((policy, index) => {
    const source = expectObject(policy, `policies[${index}]`);
    const scope = expectObject(source.scope, `policies[${index}].scope`);
    const kind = requireString(scope.kind, `policies[${index}].scope.kind`);
    if (!SCOPE_KINDS.has(kind)) {
      throw new TypeError(`policies[${index}].scope.kind is invalid`);
    }
    const period = requireString(source.period ?? "monthly", `policies[${index}].period`);
    if (!PERIODS.has(period)) {
      throw new TypeError(`policies[${index}].period is invalid`);
    }
    return {
      id: requireString(source.id, `policies[${index}].id`),
      scope: { kind, id: requireString(scope.id, `policies[${index}].scope.id`) },
      period,
      limits: normalizeLimits(source.limits, index),
      requireApprovalOnHard: Boolean(source.requireApprovalOnHard),
      modelId: source.modelId ?? null,
    };
  });
}

function normalizeLimits(value, index) {
  const source = expectObject(value , `policies[${index}].limits`);
  const limits = {};
  for (const axis of ["inputTokens", "outputTokens", "totalTokens"]) {
    if (source[axis] === undefined) continue;
    const axisLimits = expectObject(source[axis], `policies[${index}].limits.${axis}`);
    limits[axis] = {
      soft: readOptionalLimit(axisLimits.soft, `${axis}.soft`),
      hard: readOptionalLimit(axisLimits.hard, `${axis}.hard`),
    };
  }
  return limits;
}

function normalizeApproval(value) {
  if (value == null) return null;
  const source = expectObject(value, "approval");
  const decision = requireString(source.decision, "approval.decision");
  if (!APPROVAL_DECISIONS.has(decision)) {
    throw new TypeError("approval.decision is invalid");
  }
  return {
    decision,
    approverId: requireString(source.approverId, "approval.approverId"),
  };
}

function normalizeEstimatedTokens(value) {
  const source = expectObject(value , "estimatedTokens");
  return {
    inputTokens: requireNonNegativeInteger(source.inputTokens ?? 0, "estimatedTokens.inputTokens"),
    outputTokens: requireNonNegativeInteger(
      source.outputTokens ?? 0,
      "estimatedTokens.outputTokens",
    ),
  };
}

function hasEstimatedSpend(estimatedTokens) {
  return estimatedTokens.inputTokens > 0 || estimatedTokens.outputTokens > 0;
}

function readActorId(request) {
  return request.context?.actorId ?? request.subject?.id ?? null;
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function expectObject(value, label) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function expectArray(value, label) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${label} must be an array`);
  }
  return value;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

function readOptionalLimit(value, label) {
  if (value === undefined) return undefined;
  return requireNonNegativeInteger(value, label);
}
