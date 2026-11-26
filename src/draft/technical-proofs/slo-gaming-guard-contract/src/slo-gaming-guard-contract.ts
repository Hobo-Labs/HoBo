export const SLO_GAMING_GUARD_CONTRACT_VERSION = "hobo.slo-gaming-guard/v1";
export const SLO_DEFINITION_CHANGE_ASSESSED_EVENT = "slo.DefinitionChangeAssessed";

export function assessSloDefinitionChange({
  current,
  proposed,
  actor = {},
  context = {},
  history = [],
  now = new Date().toISOString(),
} = {}) {
  const currentSnapshot = sloSnapshot(current, "current", now);
  const proposedSnapshot = sloSnapshot(proposed, "proposed", now);
  const reasons = [];
  const gamingSignals = [];
  const hardDenials = [];

  if (!isNonEmptyString(actor.principal)) {
    hardDenials.push("missing-change-principal");
  }
  if (!isNonEmptyString(actor.justification)) {
    hardDenials.push("missing-change-justification");
  }

  const nowMs = toMillis(now, "now");
  const effectiveAtMs = toMillis(proposedSnapshot.effectiveAt, "proposed effectiveAt");
  if (effectiveAtMs < nowMs) {
    hardDenials.push("backdated-slo-change");
  }

  const objectiveRelaxed = hasObjectiveRelaxation(currentSnapshot.objectives, proposedSnapshot.objectives);
  const windowWidened = proposedSnapshot.timeWindowSeconds > currentSnapshot.timeWindowSeconds;
  const sliSourceChanged = currentSnapshot.sliSourceIdentity !== proposedSnapshot.sliSourceIdentity;
  const exclusionRulesChanged = currentSnapshot.exclusionRulesIdentity !== proposedSnapshot.exclusionRulesIdentity;
  const burning = isBurning(context);

  if (burning && objectiveRelaxed) {
    reasons.push("objective-relaxation-mid-burn");
  }
  if (burning && windowWidened) {
    reasons.push("window-widening-mid-burn");
  }
  if (burning && sliSourceChanged) {
    reasons.push("sli-source-change-mid-burn");
  }
  if (exclusionRulesChanged) {
    reasons.push("exclusion-rule-change-requires-policy");
  }
  if (detectIterativeRelaxation({ actor, context, history, objectiveRelaxed })) {
    gamingSignals.push("iterative-objective-relaxation-near-freeze");
  }
  if (detectPostDeployRevert({ context, history, objectiveRelaxed, currentSnapshot, proposedSnapshot })) {
    gamingSignals.push("post-deploy-revert-after-slo-relaxation");
  }

  const allReasons = [...hardDenials, ...reasons];
  const verdict = hardDenials.length > 0
    ? "deny"
    : reasons.length > 0
      ? "requires-policy-approval"
      : "allow";

  return {
    version: SLO_GAMING_GUARD_CONTRACT_VERSION,
    verdict,
    reasons: allReasons,
    gamingSignals,
    policyGate: verdict === "requires-policy-approval"
      ? {
          dimension: "can-deploy",
          action: "slo.definition.change",
          requiresHumanApproval: true,
        }
      : null,
    auditEvent: !canAudit(actor)
      ? null
      : makeAuditEvent({
          currentSnapshot,
          proposedSnapshot,
          actor,
          context,
          reasons: allReasons,
          gamingSignals,
          now,
        }),
  };
}

export function evaluateSliCoverage({
  servedRequestCount,
  countedRequestCount,
  exclusions = [],
  minAccountableCoverageRatio = 0.95,
  sourceKind = "real-user",
  realUserFailureCount = 0,
} = {}) {
  const served = assertNonNegativeNumber(servedRequestCount, "servedRequestCount");
  const counted = assertNonNegativeNumber(countedRequestCount, "countedRequestCount");
  const normalizedExclusions = exclusions.map(normalizeExclusion);
  const legitimateExcluded = normalizedExclusions
    .filter(isLegitimateExclusion)
    .reduce((total, exclusion) => total + exclusion.count, 0);
  const accountableCoverageRatio = served === 0
    ? 1
    : roundRatio((counted + legitimateExcluded) / served);
  const countedCoverageRatio = served === 0 ? 1 : roundRatio(counted / served);
  const signals = [];

  if (normalizedExclusions.some(isSuspiciousFailureExclusion)) {
    signals.push("sli-excludes-failing-traffic");
  }
  if (accountableCoverageRatio < minAccountableCoverageRatio) {
    signals.push("served-traffic-coverage-below-threshold");
  }
  if (sourceKind === "synthetic" && realUserFailureCount > 0) {
    signals.push("synthetic-only-sli-ignores-real-user-failures");
  }

  return {
    version: SLO_GAMING_GUARD_CONTRACT_VERSION,
    status: signals.length > 0 ? "gaming-signal" : "ok",
    servedRequestCount: served,
    countedRequestCount: counted,
    countedCoverageRatio,
    accountableCoverageRatio,
    minAccountableCoverageRatio,
    signals,
  };
}

export function evaluateAvailabilityGap({
  estimatedAvailability,
  observedAvailability,
  maxAllowedGap = 0.02,
} = {}) {
  const estimated = assertRatio(estimatedAvailability, "estimatedAvailability");
  const observed = assertRatio(observedAvailability, "observedAvailability");
  const gap = roundRatio(Math.max(0, estimated - observed));
  const signals = gap > maxAllowedGap ? ["availability-estimate-observed-gap"] : [];

  return {
    version: SLO_GAMING_GUARD_CONTRACT_VERSION,
    status: signals.length > 0 ? "gaming-signal" : "ok",
    estimatedAvailability: estimated,
    observedAvailability: observed,
    gap,
    maxAllowedGap,
    signals,
  };
}

function makeAuditEvent({
  currentSnapshot,
  proposedSnapshot,
  actor,
  context,
  reasons,
  gamingSignals,
  now,
}) {
  return {
    type: SLO_DEFINITION_CHANGE_ASSESSED_EVENT,
    schema: SLO_GAMING_GUARD_CONTRACT_VERSION,
    subject: `slo/${proposedSnapshot.name}`,
    actor: actor.principal,
    justification: actor.justification,
    time: now,
    change: {
      objectiveTarget: {
        from: currentSnapshot.objectiveTarget,
        to: proposedSnapshot.objectiveTarget,
      },
      objectives: {
        from: currentSnapshot.objectives,
        to: proposedSnapshot.objectives,
      },
      timeWindow: {
        from: currentSnapshot.timeWindow,
        to: proposedSnapshot.timeWindow,
      },
      sliSource: {
        from: currentSnapshot.sliSource,
        to: proposedSnapshot.sliSource,
      },
      exclusionRules: {
        from: currentSnapshot.exclusionRules,
        to: proposedSnapshot.exclusionRules,
      },
      effectiveAt: proposedSnapshot.effectiveAt,
    },
    context: {
      budgetState: context.budgetState ?? null,
      burnRate: context.burnRate ?? null,
      remainingBudgetRatio: context.remainingBudgetRatio ?? null,
    },
    reasons,
    gamingSignals,
  };
}

function sloSnapshot(definition, name, defaultEffectiveAt) {
  assertObject(definition, name);
  const sloName = requiredString(definition.metadata?.name, `${name}.metadata.name`);
  const objectives = normalizeObjectives(definition.spec?.objectives, `${name}.spec.objectives`);
  const timeWindow = requiredString(definition.spec?.timeWindow?.duration, `${name}.spec.timeWindow.duration`);
  const effectiveAt = definition.metadata?.annotations?.["hobo.dev/effectiveAt"] ?? defaultEffectiveAt;
  const sliSource = stableValue(definition.spec?.indicator ?? null);
  const exclusionRules = stableValue(definition.spec?.exclusionRules ?? definition.spec?.exclusions ?? []);

  return {
    name: sloName,
    objectiveTarget: objectives[0].target,
    objectives,
    timeWindow,
    timeWindowSeconds: parseDurationSeconds(timeWindow),
    effectiveAt,
    sliSource,
    sliSourceIdentity: stableJson(sliSource),
    exclusionRules,
    exclusionRulesIdentity: stableJson(exclusionRules),
  };
}

function normalizeObjectives(objectives, name) {
  if (!Array.isArray(objectives) || objectives.length === 0) {
    throw new Error(`${name} must be a non-empty array`);
  }
  return objectives.map((objective, index) => ({
    displayName: requiredString(objective?.displayName, `${name}.${index}.displayName`),
    target: assertRatio(objective?.target, `${name}.${index}.target`),
  }));
}

function hasObjectiveRelaxation(currentObjectives, proposedObjectives) {
  const currentByName = new Map(currentObjectives.map((objective) => [objective.displayName, objective]));
  return proposedObjectives.some((proposed, index) => {
    const current = currentByName.get(proposed.displayName) ?? currentObjectives[index];
    return current && proposed.target < current.target;
  });
}

function isBurning(context) {
  return (
    context.budgetState === "burning" ||
    context.budgetState === "exhausted" ||
    context.burning === true ||
    context.burnRate > 1
  );
}

function canAudit(actor) {
  return isNonEmptyString(actor.principal) && isNonEmptyString(actor.justification);
}

function detectIterativeRelaxation({ actor, context, history, objectiveRelaxed }) {
  if (!objectiveRelaxed || !isBurning(context)) {
    return false;
  }
  if (
    Number.isFinite(context.freezeRemainingBudgetRatio) &&
    Number.isFinite(context.remainingBudgetRatio) &&
    context.remainingBudgetRatio > context.freezeRemainingBudgetRatio
  ) {
    return false;
  }

  const sameActorRelaxations = history.filter((entry) => (
    entry.actor === actor.principal &&
    entry.objectiveTarget?.to < entry.objectiveTarget?.from
  ));
  return sameActorRelaxations.length >= 2;
}

function detectPostDeployRevert({ context, history, objectiveRelaxed, currentSnapshot, proposedSnapshot }) {
  if (objectiveRelaxed || !hasObjectiveTightening(currentSnapshot.objectives, proposedSnapshot.objectives)) {
    return false;
  }
  if (!context.deploymentLandedAt) {
    return false;
  }

  const landedAt = toMillis(context.deploymentLandedAt, "deploymentLandedAt");
  return history.some((entry) => (
    toMillis(entry.at, "history.at") < landedAt &&
    entry.objectiveTarget?.to < entry.objectiveTarget?.from
  ));
}

function hasObjectiveTightening(currentObjectives, proposedObjectives) {
  const currentByName = new Map(currentObjectives.map((objective) => [objective.displayName, objective]));
  return proposedObjectives.some((proposed, index) => {
    const current = currentByName.get(proposed.displayName) ?? currentObjectives[index];
    return current && proposed.target > current.target;
  });
}

function normalizeExclusion(exclusion) {
  assertObject(exclusion, "exclusion");
  return {
    reason: requiredString(exclusion.reason, "exclusion.reason"),
    count: assertNonNegativeNumber(exclusion.count, "exclusion.count"),
    approved: exclusion.approved === true,
    incidentId: exclusion.incidentId,
  };
}

function isLegitimateExclusion(exclusion) {
  return (
    exclusion.reason === "planned-maintenance" &&
    exclusion.approved &&
    isNonEmptyString(exclusion.incidentId)
  );
}

function isSuspiciousFailureExclusion(exclusion) {
  return !isLegitimateExclusion(exclusion) && /(5xx|error|fail|drop)/i.test(exclusion.reason);
}

function assertObject(value, name) {
  if (!isRecord(value)) {
    throw new Error(`${name} must be an object`);
  }
}

function requiredString(value, name) {
  if (!isNonEmptyString(value)) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function isNonEmptyString(value) {
  return isString(value) && value.trim().length > 0;
}

function assertRatio(value, name) {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${name} must be a ratio between 0 and 1`);
  }
  return value;
}

function assertNonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return value;
}

function parseDurationSeconds(duration) {
  const match = /^([1-9][0-9]*)(s|m|h|d|w|M|Q|Y)$/.exec(duration);
  if (!match) {
    throw new Error(`invalid duration: ${duration}`);
  }
  const units = {
    s: 1,
    m: 60,
    h: 3600,
    d: 86400,
    w: 604800,
    M: 2592000,
    Q: 7776000,
    Y: 31536000,
  };
  return Number(match[1]) * units[match[2]];
}

function toMillis(value, name) {
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
  return millis;
}

function roundRatio(value) {
  return Number(value.toFixed(6));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function stableValue(value) {
  if (Array.isArray(value)) {
    return value.map(stableValue);
  }
  if (!isRecord(value) && !Array.isArray(value)) {
    return value ?? null;
  }
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, stableValue(value[key])]),
  );
}

function isRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
