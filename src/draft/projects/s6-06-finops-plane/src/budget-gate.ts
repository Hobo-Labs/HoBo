import { createDecisionRequest } from "../../../technical-proofs/hobo-policy-ir-contract/src/policy-ir.js";
import { evaluateBudgetQuotaPolicy } from "../../../technical-proofs/budget-quota-policy-contract/src/budget-quota-policy.js";
import { isJsonString, isJsonObject } from "./json.js";


export const FINOPS_DEPLOY_GATE_ENGINE = "hobo.finops.deploy-gate/contract@0.1.0";

export function evaluateFinOpsDeployGate(input) {
  const source = expectObject(input, "input");
  const estimateUsd = requireNonNegativeNumber(source.costEstimateUsd, "costEstimateUsd");
  const meteringView = source.meteringView;
  const policies = normalizePolicies(source.policies);
  const owner = expectObject(source.owner, "owner");
  const campScope = `${requireString(owner.tenantId, "owner.tenantId")}/${requireString(owner.campId, "owner.campId")}`;
  const agentScope = `${requireString(owner.tenantId, "owner.tenantId")}/${requireString(owner.agentId ?? "agent-deploy", "owner.agentId")}`;

  const request = createDecisionRequest({
    schemaVersion: "hobo.policy-ir/v1",
    subject: {
      kind: "agent",
      id: `agent:${owner.tenantId}/${owner.agentId ?? "agent-deploy"}`,
      delegatedBy: "user:platform-admin",
      roles: ["deployer"],
      scopes: ["hobo:deployment:apply"],
    },
    action: "hobo:deployment:apply",
    resource: {
      kind: "deployment",
      id: `deployment:${owner.bindleId ?? "checkout"}`,
    },
    phase: "plan",
    context: {
      owner,
      costEstimateUsd: estimateUsd,
      campScope,
    },
  });

  const scopedMeteringView = seedOwnerScopeCosts(meteringView, {
    camp: campScope,
    agent: agentScope,
  });
  const result = evaluateBudgetQuotaPolicy({
    request,
    meteringView: scopedMeteringView,
    policies,
    approval: source.approval ?? null,
    reservation: source.reservation ?? null,
  });

  return {
    engine: FINOPS_DEPLOY_GATE_ENGINE,
    effect: result.decision.effect,
    reason: result.decision.reason,
    costEstimateUsd: estimateUsd,
    violations: result.decision.violations ?? [],
    obligations: result.decision.obligations ?? [],
    policyEvent: result.policyEvent,
    blocksDeploy: result.decision.effect === "deny",
    requiresApproval: result.decision.effect === "require-approval",
  };
}

function seedOwnerScopeCosts(meteringView, scopes) {
  const view = expectObject(meteringView, "meteringView");
  const existing = view.scopeCosts ?? {};
  const merged = { ...existing };
  for (const [kind, id] of Object.entries(scopes)) {
    const scopeKey = `${kind}:${id}`;
    merged[scopeKey] = {
      cost: readExistingScopeCost(view, kind, id),
      currency: view.currency ?? "USD",
    };
  }
  return {
    ...view,
    scopeCosts: merged,
  };
}

function readExistingScopeCost(meteringView, kind, id) {
  const key = `${kind}:${id}`;
  const direct = readCounterValue(meteringView.scopeCosts?.[key]);
  if (direct !== null) {
    return direct;
  }
  const spendByScope = readCounterValue(meteringView.spendByScope?.[key]);
  if (spendByScope !== null) {
    return spendByScope;
  }
  const scopeSpendUsd = readCounterValue(meteringView.scopeSpendUsd?.[key]);
  if (scopeSpendUsd !== null) {
    return scopeSpendUsd;
  }
  if (singlePrincipalScopeMatches(meteringView, kind, id)) {
    return readCounterValue(meteringView.totalCost) ?? 0;
  }
  return 0;
}

function readCounterValue(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (Number.isFinite(input) && input >= 0) {
    return input;
  }
  if (isJsonObject(input) && !Array.isArray(input)) {
    for (const key of ["cost", "costUsd", "spendUsd", "value"]) {
      if (Number.isFinite(input[key]) && input[key] >= 0) {
        return input[key];
      }
    }
  }
  throw new TypeError("metering scope counter must be a non-negative USD number");
}

function singlePrincipalScopeMatches(meteringView, kind, id) {
  const hierarchyKey = kind === "tenant" ? "tenants" : kind === "camp" ? "camps" : "agents";
  const values = meteringView.principalHierarchy?.[hierarchyKey];
  return Array.isArray(values) && values.length === 1 && values[0] === id;
}

function normalizePolicies(policies) {
  if (!Array.isArray(policies)) {
    throw new TypeError("policies must be an array");
  }
  return policies;
}

function expectObject(value, label) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function requireString(value, label) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string`);
  }
  return value;
}

function requireNonNegativeNumber(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new TypeError(`${label} must be a non-negative number`);
  }
  return number;
}
