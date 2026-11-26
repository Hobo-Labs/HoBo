import { createHash } from "node:crypto";
import { isJsonString, isJsonObject } from "./json.js";


export const ERROR_BUDGET_DEPLOY_GATE_VERSION = "hobo.error-budget-deploy-gate/v1";

export function evaluateErrorBudgetDeployGate({
  deploy,
  slo,
  policy = {},
  now = new Date().toISOString(),
  previousDecision,
  recheckedFromDecisionId,
}) {
  const normalizedDeploy = normalizeDeploy(deploy);
  const normalizedSlo = normalizeSlo(slo);
  const normalizedPreviousDecision = normalizePreviousDecision(previousDecision);
  const recoveryHysteresis = normalizeRecoveryHysteresis(policy.recoveryHysteresis);
  const breakGlass = normalizeBreakGlass(policy.breakGlass, now);
  const input = {
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    deploy: normalizedDeploy,
    slo: normalizedSlo,
    previousDecision: normalizedPreviousDecision,
    recheckedFromDecisionId,
    policy: {
      freezeBurnRate: policy.freezeBurnRate ?? 8,
      minRemainingBudgetRatio: policy.minRemainingBudgetRatio ?? 0.05,
      recoveryHysteresis,
      breakGlass,
    },
  };
  const inputHash = stableDigest(input);
  const shouldFreeze =
    normalizedSlo.status === "burning" ||
    normalizedSlo.burnRate >= input.policy.freezeBurnRate ||
    normalizedSlo.remainingBudgetRatio <= input.policy.minRemainingBudgetRatio;
  const recoveredFromFreeze = !shouldFreeze && normalizedPreviousDecision?.effect === "deny";
  const hysteresisHeld =
    recoveredFromFreeze &&
    recoveryHysteresis &&
    recoveryHysteresis.healthySnapshots < recoveryHysteresis.minHealthySnapshots;
  const breakGlassAllowed = shouldFreeze && breakGlass?.valid === true;
  const decision = decideGate({ shouldFreeze, breakGlassAllowed, hysteresisHeld, recoveredFromFreeze });
  const event = policyDecidedEvent({
    deploy: normalizedDeploy,
    decision,
    now,
    evidence: {
      inputHash,
      sloId: normalizedSlo.sloId,
      sloSeq: normalizedSlo.seq,
      burnRate: normalizedSlo.burnRate,
      remainingBudgetRatio: normalizedSlo.remainingBudgetRatio,
      previousDecisionId: normalizedPreviousDecision?.id,
      recheckedFromDecisionId,
      hysteresis: hysteresisHeld ? recoveryHysteresis : undefined,
      breakGlass: breakGlassAllowed ? publicBreakGlass(breakGlass) : undefined,
    },
  });

  return {
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    status: decision.effect === "deny" ? "blocked" : "allowed",
    decision,
    inputHash,
    events: [event],
  };
}

export function applyDeploymentAfterGate({ deploy, gateDecision, latestSlo, policy = {}, now = new Date().toISOString() }) {
  if (!gateDecision || gateDecision.type !== "policy.Decided") {
    throw new Error("gateDecision must be a policy.Decided event");
  }

  const result = evaluateErrorBudgetDeployGate({
    deploy,
    slo: latestSlo,
    policy,
    now,
    previousDecision: {
      id: gateDecision.id,
      effect: gateDecision.data.effect,
      reason: gateDecision.data.reason,
      decidedAt: gateDecision.data.decidedAt,
    },
    recheckedFromDecisionId: gateDecision.id,
  });

  return {
    ...result,
    status: result.decision.effect === "allow" ? "applied" : "blocked-at-apply",
    applied: result.decision.effect === "allow",
  };
}

export function replayErrorBudgetDeployGate(events) {
  return {
    decisions: events.filter((event) => event.type === "policy.Decided"),
    obligations: events.filter((event) => event.type.startsWith("policy.Obligation")),
    rollbacks: events.filter((event) => event.type === "rollout.RolledBack" || event.type === "rollout.RollbackFailed"),
    flagReverts: events.filter((event) => event.type === "flag.Changed" || event.type === "flag.RevertFailed"),
  };
}

export function handleAutoRevertObligationSignal({
  obligationEvent,
  sloBurnEvent,
  autoRevertResult = { status: "succeeded" },
  now = new Date().toISOString(),
}) {
  const obligation = normalizeAutoRevertObligation(obligationEvent);
  if (!sloBurnEvent || sloBurnEvent.type !== "slo.BudgetBurned") {
    return { schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION, status: "waiting-for-burn", events: [] };
  }

  const triggered = obligationTriggeredEvent({ obligation, sloBurnEvent, now });
  const failed = autoRevertResult.status === "failed";
  const resultEvent = failed
    ? autoRevertFailureEvent({ obligation, sloBurnEvent, autoRevertResult, now })
    : autoRevertSuccessEvent({ obligation, sloBurnEvent, now });
  const terminalEvent = failed
    ? obligationEscalatedEvent({ obligation, triggerEvent: triggered, failedEvent: resultEvent, now })
    : obligationSatisfiedEvent({ obligation, triggerEvent: triggered, resultEvent, now });

  return {
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    status: failed ? "escalated" : "satisfied",
    events: [triggered, resultEvent, terminalEvent],
  };
}

export function stableDigest(value) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function decideGate({ shouldFreeze, breakGlassAllowed, hysteresisHeld, recoveredFromFreeze }) {
  if (breakGlassAllowed) {
    return { effect: "allow", reason: "error-budget-break-glass" };
  }
  if (shouldFreeze) {
    return { effect: "deny", reason: "error-budget-freeze" };
  }
  if (hysteresisHeld) {
    return { effect: "deny", reason: "error-budget-hysteresis-hold" };
  }
  return {
    effect: "allow",
    reason: recoveredFromFreeze ? "error-budget-recovered" : "error-budget-healthy",
  };
}

function policyDecidedEvent({ deploy, decision, evidence, now }) {
  return {
    id: `policy.Decided:${deploy.deployId}:${evidence.sloSeq}`,
    type: "policy.Decided",
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    streamId: `deploy:${deploy.deployId}`,
    data: {
      decisionId: `decision:${deploy.deployId}:${evidence.sloSeq}`,
      effect: decision.effect,
      reason: decision.reason,
      subject: deploy.actor,
      resource: {
        kind: "deployment",
        id: deploy.deployId,
        bindle: deploy.bindle,
        camp: deploy.camp,
        environment: deploy.environment,
      },
      action: "hobo:deploy:apply",
      phase: deploy.phase,
      dimension: "error-budget",
      evidence,
      decidedAt: now,
    },
  };
}

function obligationTriggeredEvent({ obligation, sloBurnEvent, now }) {
  return {
    id: `policy.ObligationTriggered:${obligation.id}:${sloBurnEvent.id}`,
    type: "policy.ObligationTriggered",
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    streamId: obligation.streamId,
    data: {
      obligationId: obligation.id,
      policyDecisionId: obligation.policyDecisionId,
      signalEventId: sloBurnEvent.id,
      signalType: sloBurnEvent.type,
      target: obligation.target,
      triggeredAt: now,
    },
  };
}

function autoRevertSuccessEvent({ obligation, sloBurnEvent, now }) {
  if (obligation.target.kind === "rollout") {
    return {
      id: `rollout.RolledBack:${obligation.target.rolloutId}:${sloBurnEvent.id}`,
      type: "rollout.RolledBack",
      schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
      streamId: `rollout:${obligation.target.rolloutId}`,
      data: {
        rolloutId: obligation.target.rolloutId,
        fromVersion: obligation.target.toVersion,
        restoredVersion: obligation.target.fromVersion,
        reason: "error-budget-auto-revert",
        strategySaga: "deployment-strategy-saga-templates",
        obligationId: obligation.id,
        policyDecisionId: obligation.policyDecisionId,
        signalEventId: sloBurnEvent.id,
        rolledBackAt: now,
      },
    };
  }

  return {
    id: `flag.Changed:${obligation.target.flagKey}:${sloBurnEvent.id}`,
    type: "flag.Changed",
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    streamId: `flag:${obligation.target.flagKey}`,
    data: {
      flagKey: obligation.target.flagKey,
      restoredVariation: obligation.target.previousVariation,
      reason: "error-budget-auto-revert",
      flagPlane: "policy-gated-flag-flips",
      obligationId: obligation.id,
      policyDecisionId: obligation.policyDecisionId,
      signalEventId: sloBurnEvent.id,
      changedAt: now,
    },
  };
}

function autoRevertFailureEvent({ obligation, sloBurnEvent, autoRevertResult, now }) {
  const reason = autoRevertResult.reason ?? "auto-revert failed";
  if (obligation.target.kind === "rollout") {
    return {
      id: `rollout.RollbackFailed:${obligation.target.rolloutId}:${sloBurnEvent.id}`,
      type: "rollout.RollbackFailed",
      schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
      streamId: `rollout:${obligation.target.rolloutId}`,
      data: {
        rolloutId: obligation.target.rolloutId,
        reason,
        strategySaga: "deployment-strategy-saga-templates",
        obligationId: obligation.id,
        policyDecisionId: obligation.policyDecisionId,
        signalEventId: sloBurnEvent.id,
        failedAt: now,
      },
    };
  }

  return {
    id: `flag.RevertFailed:${obligation.target.flagKey}:${sloBurnEvent.id}`,
    type: "flag.RevertFailed",
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    streamId: `flag:${obligation.target.flagKey}`,
    data: {
      flagKey: obligation.target.flagKey,
      reason,
      flagPlane: "policy-gated-flag-flips",
      obligationId: obligation.id,
      policyDecisionId: obligation.policyDecisionId,
      signalEventId: sloBurnEvent.id,
      failedAt: now,
    },
  };
}

function obligationSatisfiedEvent({ obligation, triggerEvent, resultEvent, now }) {
  return {
    id: `policy.ObligationSatisfied:${obligation.id}:${resultEvent.id}`,
    type: "policy.ObligationSatisfied",
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    streamId: obligation.streamId,
    data: {
      obligationId: obligation.id,
      triggerEventId: triggerEvent.id,
      resultEventId: resultEvent.id,
      satisfiedAt: now,
    },
  };
}

function obligationEscalatedEvent({ obligation, triggerEvent, failedEvent, now }) {
  return {
    id: `policy.ObligationEscalated:${obligation.id}:${failedEvent.id}`,
    type: "policy.ObligationEscalated",
    schemaVersion: ERROR_BUDGET_DEPLOY_GATE_VERSION,
    streamId: obligation.streamId,
    data: {
      obligationId: obligation.id,
      triggerEventId: triggerEvent.id,
      failedEventId: failedEvent.id,
      compensation: "manual-rollback-or-traffic-drain-required",
      escalatedAt: now,
    },
  };
}

function normalizeDeploy(deploy) {
  assertObject(deploy, "deploy");
  assertNonEmptyString(deploy.deployId, "deploy.deployId");
  assertNonEmptyString(deploy.bindle, "deploy.bindle");
  assertNonEmptyString(deploy.camp, "deploy.camp");
  assertNonEmptyString(deploy.environment, "deploy.environment");
  assertObject(deploy.actor, "deploy.actor");

  return {
    deployId: deploy.deployId,
    bindle: deploy.bindle,
    camp: deploy.camp,
    environment: deploy.environment,
    phase: deploy.phase ?? "can-deploy",
    actor: cloneJson(deploy.actor),
  };
}

function normalizeSlo(slo) {
  assertObject(slo, "slo");
  assertNonEmptyString(slo.sloId, "slo.sloId");
  if (!Number.isInteger(slo.seq) || slo.seq < 0) {
    throw new Error("slo.seq must be a non-negative integer");
  }

  return {
    seq: slo.seq,
    generatedAt: slo.generatedAt,
    sloId: slo.sloId,
    status: slo.status ?? "unknown",
    burnRate: finiteNumber(slo.burnRate, "slo.burnRate"),
    remainingBudgetRatio: finiteNumber(slo.remainingBudgetRatio, "slo.remainingBudgetRatio"),
    window: slo.window,
  };
}

function normalizePreviousDecision(decision) {
  if (decision === undefined || decision === null) {
    return null;
  }
  assertObject(decision, "previousDecision");
  assertNonEmptyString(decision.id, "previousDecision.id");
  assertNonEmptyString(decision.effect, "previousDecision.effect");

  return {
    id: decision.id,
    effect: decision.effect,
    reason: decision.reason,
    decidedAt: decision.decidedAt,
  };
}

function normalizeRecoveryHysteresis(hysteresis) {
  if (hysteresis === undefined || hysteresis === null) {
    return null;
  }
  assertObject(hysteresis, "policy.recoveryHysteresis");
  const minHealthySnapshots = positiveInteger(hysteresis.minHealthySnapshots ?? 1, "policy.recoveryHysteresis.minHealthySnapshots");
  const healthySnapshots = nonNegativeInteger(hysteresis.healthySnapshots ?? 0, "policy.recoveryHysteresis.healthySnapshots");
  return {
    minHealthySnapshots,
    healthySnapshots,
    window: hysteresis.window ?? "instant",
  };
}

function normalizeBreakGlass(breakGlass, now) {
  if (breakGlass === undefined || breakGlass === null) {
    return null;
  }
  assertObject(breakGlass, "policy.breakGlass");
  assertNonEmptyString(breakGlass.id, "policy.breakGlass.id");
  assertNonEmptyString(breakGlass.approvedBy, "policy.breakGlass.approvedBy");
  assertNonEmptyString(breakGlass.reason, "policy.breakGlass.reason");
  assertNonEmptyString(breakGlass.expiresAt, "policy.breakGlass.expiresAt");
  return {
    id: breakGlass.id,
    approvedBy: breakGlass.approvedBy,
    reason: breakGlass.reason,
    expiresAt: breakGlass.expiresAt,
    valid: Date.parse(breakGlass.expiresAt) > Date.parse(now),
  };
}

function publicBreakGlass(breakGlass) {
  return {
    id: breakGlass.id,
    approvedBy: breakGlass.approvedBy,
    reason: breakGlass.reason,
    expiresAt: breakGlass.expiresAt,
  };
}

function normalizeAutoRevertObligation(obligationEvent) {
  assertObject(obligationEvent, "obligationEvent");
  assertNonEmptyString(obligationEvent.id, "obligationEvent.id");
  if (obligationEvent.type !== "policy.ObligationCreated") {
    throw new Error("obligationEvent.type must be policy.ObligationCreated");
  }
  assertObject(obligationEvent.data, "obligationEvent.data");
  assertObject(obligationEvent.data.obligation, "obligationEvent.data.obligation");
  if (obligationEvent.data.obligation.kind !== "error-budget.auto-revert") {
    throw new Error("obligation kind must be error-budget.auto-revert");
  }

  return {
    id: obligationEvent.id,
    streamId: obligationEvent.streamId ?? obligationEvent.id,
    policyDecisionId: obligationEvent.data.policyDecisionId,
    target: normalizeAutoRevertTarget(obligationEvent.data.obligation.target),
  };
}

function normalizeAutoRevertTarget(target) {
  assertObject(target, "obligationEvent.data.obligation.target");
  if (target.kind === "rollout") {
    assertNonEmptyString(target.rolloutId, "obligation target.rolloutId");
    assertNonEmptyString(target.fromVersion, "obligation target.fromVersion");
    assertNonEmptyString(target.toVersion, "obligation target.toVersion");
    return {
      kind: "rollout",
      rolloutId: target.rolloutId,
      fromVersion: target.fromVersion,
      toVersion: target.toVersion,
    };
  }
  if (target.kind === "feature-flag") {
    assertNonEmptyString(target.flagKey, "obligation target.flagKey");
    assertNonEmptyString(target.previousVariation, "obligation target.previousVariation");
    return {
      kind: "feature-flag",
      flagKey: target.flagKey,
      previousVariation: target.previousVariation,
    };
  }
  throw new Error("obligation target.kind must be rollout or feature-flag");
}

function canonicalJson(value) {
  return `${JSON.stringify(sortKeys(value), null, 2)}\n`;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertObject(value, name) {
  if (!value || !isJsonObject(value) || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function assertNonEmptyString(value, name) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
}

function finiteNumber(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${name} must be a finite number`);
  }
  return number;
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
