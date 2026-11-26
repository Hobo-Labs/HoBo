import {
  createBuiltInPolicyEngine,
  createRuleset,
  defineTypescriptRule,
  evaluateAndRecordPolicyDecision
} from "../../built-in-policy-engine-contract/src/built-in-policy-engine.js";
import {
  createDecisionRequest,
  POLICY_IR_SCHEMA_VERSION
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonObject } from "./json.js";


export const FLAG_CHANGE_ACTION = "hobo:feature-flag:change";
export const FLAG_CHANGE_PHASE = "runtime";
export const FEATURE_FLAG_GOVERNANCE_RULESET_ID =
  "policy-pack:feature-flag-governance";
export const PROD_KILL_SWITCH_APPROVAL = "feature-flag.prod-kill-switch";
export const RISKY_PERCENTAGE_BUMP_APPROVAL =
  "feature-flag.risky-percentage-bump";
export const AUTO_REVERT_OBLIGATION =
  "feature-flag.auto-revert-on-slo-burn";

export async function evaluateFeatureFlagChangeGovernance({
  change,
  auditSink = () => undefined,
  engine = createBuiltInPolicyEngine(),
  ruleset = createFeatureFlagGovernanceRuleset()
} = {}) {
  const request = createFlagChangeDecisionRequest(change);

  return evaluateAndRecordPolicyDecision({
    engine,
    request,
    ruleset,
    auditSink
  });
}

export function fireAutoRevertObligations({ decision, signal } = {}) {
  if (!decision || !isJsonObject(decision)) {
    throw new TypeError("decision is required");
  }
  if (!signal || !isJsonObject(signal)) {
    throw new TypeError("signal is required");
  }

  return (decision.obligations ?? [])
    .filter((obligation) => obligation.kind === AUTO_REVERT_OBLIGATION)
    .filter((obligation) => obligation.durable === true)
    .filter((obligation) => signal.type === obligation.trigger?.type)
    .filter((obligation) => signal.flagKey === obligation.flagKey)
    .filter((obligation) => signal.environment === obligation.environment)
    .map((obligation) => ({
      type: "flag.RevertRequested",
      streamId: `flag:${obligation.flagKey}`,
      data: {
        environment: obligation.environment,
        flagKey: obligation.flagKey,
        from: obligation.revert.from,
        to: obligation.revert.to,
        reason: "slo-burn-auto-revert",
        obligationKind: obligation.kind
      }
    }));
}

export function createFeatureFlagGovernanceRuleset() {
  return createRuleset({
    id: FEATURE_FLAG_GOVERNANCE_RULESET_ID,
    version: "1.0.0",
    rules: [
      defineTypescriptRule({
        id: "policy:feature-flag/change-governance",
        when: ({ request }) =>
          request.action === FLAG_CHANGE_ACTION &&
          request.resource.kind === "feature-flag" &&
          request.phase === FLAG_CHANGE_PHASE,
        decide: ({ request }) => decideFlagChange(request.context.flagChange)
      })
    ]
  });
}

export function createFlagChangeDecisionRequest(change) {
  const normalized = normalizeFlagChange(change);

  return createDecisionRequest({
    schemaVersion: POLICY_IR_SCHEMA_VERSION,
    subject: {
      kind: normalized.actor.kind,
      id: normalized.actor.id
    },
    action: FLAG_CHANGE_ACTION,
    resource: {
      kind: "feature-flag",
      id: normalized.flagKey
    },
    phase: FLAG_CHANGE_PHASE,
    context: {
      flagChange: normalized
    }
  });
}

function decideFlagChange(change) {
  if (isPolicyGateBypass(change)) {
    return {
      effect: "deny",
      reason: "prod feature-flag changes must pass through policy gate",
      violations: [
        "prod feature-flag changes must be evaluated through the policy gate"
      ]
    };
  }

  if (isEvaluatorOutageFailClosed(change)) {
    return {
      effect: "deny",
      reason: "flag evaluator unavailable; fail-closed policy denies prod flip",
      violations: [
        "flag evaluator unavailable; fail-closed policy denies prod flip"
      ]
    };
  }

  if (isProdKillSwitch(change)) {
    return {
      effect: "require-approval",
      reason: "prod kill-switch flag flips require approval",
      approvals: [
        {
          kind: PROD_KILL_SWITCH_APPROVAL,
          environment: change.environment,
          flagKey: change.flagKey
        }
      ]
    };
  }

  if (isRiskyProdPercentageBump(change)) {
    return {
      effect: "require-approval",
      reason: "risky prod percentage rollout carries auto-revert obligation",
      approvals: [
        {
          kind: RISKY_PERCENTAGE_BUMP_APPROVAL,
          environment: change.environment,
          flagKey: change.flagKey
        }
      ],
      obligations: [createAutoRevertObligation(change)]
    };
  }

  return {
    effect: "allow",
    reason: "flag change is ungated"
  };
}

function isProdKillSwitch(change) {
  return change.environment === "prod" && change.operation === "kill-switch";
}

function isPolicyGateBypass(change) {
  return change.environment === "prod" && change.bypassPolicyGate === true;
}

function isEvaluatorOutageFailClosed(change) {
  return (
    change.environment === "prod" &&
    change.evaluator?.available === false &&
    change.evaluator.failurePolicy === "fail-closed"
  );
}

function isRiskyProdPercentageBump(change) {
  const from = change.percentage?.from;
  const to = change.percentage?.to;

  return (
    change.environment === "prod" &&
    change.operation === "percentage-rollout" &&
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    to > from &&
    (to >= 50 || to - from >= 25)
  );
}

function createAutoRevertObligation(change) {
  return {
    kind: AUTO_REVERT_OBLIGATION,
    durable: true,
    environment: change.environment,
    flagKey: change.flagKey,
    trigger: {
      type: "slo.Burned"
    },
    revert: {
      from: change.percentage.to,
      to: change.percentage.from
    }
  };
}

function normalizeFlagChange(change) {
  if (!change || !isJsonObject(change) || Array.isArray(change)) {
    throw new TypeError("change must be an object");
  }
  if (!change.actor || !isJsonObject(change.actor)) {
    throw new TypeError("change.actor is required");
  }

  const normalized = {
    actor: {
      kind: requiredString(change.actor.kind, "change.actor.kind"),
      id: requiredString(change.actor.id, "change.actor.id")
    },
    environment: requiredString(change.environment, "change.environment"),
    flagKey: requiredString(change.flagKey, "change.flagKey"),
    from: cloneJson(change.from),
    operation: requiredString(change.operation, "change.operation"),
    to: cloneJson(change.to),
    valueType: requiredString(change.valueType, "change.valueType")
  };

  if (change.percentage !== undefined) {
    normalized.percentage = {
      from: requiredFiniteNumber(change.percentage.from, "change.percentage.from"),
      to: requiredFiniteNumber(change.percentage.to, "change.percentage.to")
    };
  }

  if (change.actor.tenant !== undefined) {
    normalized.actor.tenant = requiredString(change.actor.tenant, "change.actor.tenant");
  }
  if (change.bypassPolicyGate !== undefined) {
    normalized.bypassPolicyGate = change.bypassPolicyGate === true;
  }
  if (change.claimedRisk !== undefined) {
    normalized.claimedRisk = requiredString(change.claimedRisk, "change.claimedRisk");
  }
  if (change.evaluator !== undefined) {
    normalized.evaluator = {
      available: Boolean(change.evaluator.available),
      failurePolicy: requiredString(
        change.evaluator.failurePolicy ?? "fail-closed",
        "change.evaluator.failurePolicy"
      )
    };
  }

  return normalized;
}

function requiredString(value, path) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${path} must be a non-empty string`);
  }
  return value;
}

function requiredFiniteNumber(value, path) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${path} must be a finite number`);
  }
  return value;
}

function cloneJson(value) {
  if (value === undefined) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value));
}
