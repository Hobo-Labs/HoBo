import { createHash } from "node:crypto";

import {
  canonicalJson,
  createDecision,
  createDecisionRequest,
  createPolicyDecidedEvent,
} from "../../hobo-policy-ir-contract/src/policy-ir.js";
import { isJsonString, isJsonBoolean, isJsonObject } from "./json.js";


export const BUDGET_QUOTA_POLICY_ENGINE_ID = "hobo.budget-quota-policy/contract@0.1.0";
export const BUDGET_QUOTA_POLICY_SCHEMA_VERSION = "hobo.budget-quota-policy/v1";

const SCOPE_KINDS = new Set(["tenant", "camp", "agent"]);
const APPROVAL_DECISIONS = new Set(["approved", "denied"]);

export function evaluateBudgetQuotaPolicy(input) {
  const source = expectObject(input, "input");
  const request = createDecisionRequest(source.request);
  const meteringView = normalizeMeteringView(source.meteringView);
  const policies = normalizePolicies(source.policies);
  const approval = normalizeApproval(source.approval);
  const reservation = normalizeReservation(source.reservation);
  const estimateUsd = readCost(request.context, "costEstimateUsd", "estimatedCostUsd");
  const actualUsd = readOptionalCost(request.context, "actualCostUsd");

  const state = {
    request,
    meteringView,
    estimateUsd,
    actualUsd,
    approval,
    reservation,
    evaluations: [],
    events: [],
    obligations: [],
    approvals: [],
    violations: [],
    missingQuotaContext: policies.length === 0 && estimateUsd > 0,
    stalePolicies: [],
    reservationViolations: [],
    hardViolations: [],
    approvalDenied: [],
    approvalNeeded: [],
    driftPolicies: [],
    degradationPolicies: [],
  };

  if (state.missingQuotaContext) {
    state.violations.push("missing quota policy context for spend-incurring action");
    state.events.push(createQuotaContextMissingEvent({ request, meteringView, estimateUsd }));
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
      engine: BUDGET_QUOTA_POLICY_ENGINE_ID,
      policyIds: policies.map((policy) => policy.id),
    },
  });

  const policyEvent = createAuditedPolicyEvent({
    request,
    decision,
    meteringView,
    estimateUsd,
    actualUsd,
    actorId: readActorId(request),
    approverId: approval?.approverId ?? null,
    policyIds: policies.map((policy) => policy.id),
  });

  return {
    schemaVersion: BUDGET_QUOTA_POLICY_SCHEMA_VERSION,
    request,
    decision,
    events: [policyEvent, ...state.events],
    evaluations: state.evaluations,
  };
}

function evaluatePolicy(state, policy) {
  const scopeSpend = readScopeSpend(state.meteringView, policy.scope);
  const currentSpendUsd = scopeSpend.value;
  const projectedSpendUsd = roundUsd(currentSpendUsd + state.estimateUsd);
  const actualProjectedSpendUsd =
    state.actualUsd === null ? null : roundUsd(currentSpendUsd + state.actualUsd);
  const reservationProjectedSpendUsd = state.reservation
    ? roundUsd(currentSpendUsd + state.reservation.reservedCostUsd)
    : null;
  const evaluation = {
    policyId: policy.id,
    scope: policy.scope,
    currentSpendUsd,
    estimatedCostUsd: state.estimateUsd,
    projectedSpendUsd,
    reservationProjectedSpendUsd,
    actualCostUsd: state.actualUsd,
    actualProjectedSpendUsd,
    meteringViewSeq: state.meteringView.seq,
  };
  state.evaluations.push(evaluation);

  if (!scopeSpend.found && state.estimateUsd > 0) {
    state.missingQuotaContext = true;
    state.violations.push(
      `${policy.id}: missing MeteringView quota counter for ${policy.scope.kind}:${policy.scope.id}`,
    );
    state.events.push(
      createQuotaContextMissingEvent({
        request: state.request,
        meteringView: state.meteringView,
        estimateUsd: state.estimateUsd,
        policy,
      }),
    );
    return;
  }

  if (state.meteringView.seq < policy.lastEvaluatedSeq) {
    state.stalePolicies.push(policy);
    state.violations.push(
      `${policy.id}: out-of-order MeteringView seq ${state.meteringView.seq} is older than ${policy.lastEvaluatedSeq}`,
    );
    state.events.push(
      createSpendEvent({
        type: "spend.CounterOutOfOrder",
        request: state.request,
        meteringView: state.meteringView,
        policy,
        currentSpendUsd,
        projectedSpendUsd,
        extra: {
          lastEvaluatedSeq: policy.lastEvaluatedSeq,
        },
      }),
    );
    return;
  }

  const reservationViolationCount = state.reservationViolations.length;
  evaluatePreCommitReservation(state, policy, { currentSpendUsd, projectedSpendUsd });
  if (state.reservationViolations.length > reservationViolationCount) {
    return;
  }

  evaluateBudgetThresholds(state, policy, { currentSpendUsd, projectedSpendUsd });
  evaluateAgentSpendCap(state, policy, { currentSpendUsd, projectedSpendUsd });
  evaluateEstimateDrift(state, policy, {
    currentSpendUsd,
    projectedSpendUsd,
    actualProjectedSpendUsd,
  });
  evaluateCostAvailabilityProfile(state, policy, { currentSpendUsd, projectedSpendUsd });
}

function evaluatePreCommitReservation(state, policy, { currentSpendUsd, projectedSpendUsd }) {
  if (!policy.reservationRequired) {
    return;
  }

  const reservation = state.reservation;
  const denyReservation = (reason, extra = {}) => {
    state.reservationViolations.push(policy);
    state.violations.push(`${policy.id}: ${reason}`);
    state.events.push(
      createSpendEvent({
        type: "spend.QuotaReservationDenied",
        request: state.request,
        meteringView: state.meteringView,
        policy,
        currentSpendUsd,
        projectedSpendUsd,
        extra: {
          reason,
          reservationRequired: true,
          ...extra,
        },
      }),
    );
  };

  if (!reservation) {
    denyReservation("missing pre-commit quota reservation");
    return;
  }

  if (!sameScope(reservation.scope, policy.scope)) {
    denyReservation("pre-commit quota reservation scope mismatch", {
      reservationScopeKind: reservation.scope.kind,
      reservationScopeId: reservation.scope.id,
    });
    return;
  }

  if (!reservation.granted) {
    denyReservation(reservation.reason ?? "pre-commit quota reservation denied", {
      counterId: reservation.counterId,
      reservedCostUsd: reservation.reservedCostUsd,
      inFlightActionId: reservation.inFlightActionId,
    });
    return;
  }

  if (reservation.reservedCostUsd < state.estimateUsd) {
    denyReservation("pre-commit quota reservation is smaller than estimated spend", {
      counterId: reservation.counterId,
      reservedCostUsd: reservation.reservedCostUsd,
      estimatedCostUsd: state.estimateUsd,
    });
    return;
  }

  const reservationProjectedSpendUsd = roundUsd(currentSpendUsd + reservation.reservedCostUsd);
  if (policy.hardLimitUsd !== null && reservationProjectedSpendUsd > policy.hardLimitUsd) {
    denyReservation("pre-commit quota reservation would exceed hard budget", {
      counterId: reservation.counterId,
      reservedCostUsd: reservation.reservedCostUsd,
      hardLimitUsd: policy.hardLimitUsd,
      reservationProjectedSpendUsd,
    });
    maybeAddCompensationObligation(state);
    return;
  }

  state.events.push(
    createSpendEvent({
      type: "spend.QuotaReservationCommitted",
      request: state.request,
      meteringView: state.meteringView,
      policy,
      currentSpendUsd,
      projectedSpendUsd,
      extra: {
        counterId: reservation.counterId,
        reservedCostUsd: reservation.reservedCostUsd,
        reservationProjectedSpendUsd,
        inFlightActionId: reservation.inFlightActionId,
        maxOvershootUsd: reservation.reservedCostUsd,
      },
    }),
  );
}

function evaluateBudgetThresholds(state, policy, { currentSpendUsd, projectedSpendUsd }) {
  if (policy.hardLimitUsd !== null && projectedSpendUsd > policy.hardLimitUsd) {
    state.hardViolations.push(policy);
    state.violations.push(
      `${policy.id}: projected spend ${projectedSpendUsd} exceeds hard budget ${policy.hardLimitUsd}`,
    );
    state.events.push(
      createSpendEvent({
        type: "spend.BudgetThresholdCrossed",
        request: state.request,
        meteringView: state.meteringView,
        policy,
        currentSpendUsd,
        projectedSpendUsd,
        extra: {
          thresholdUsd: policy.hardLimitUsd,
          severity: "hard",
          blocked: true,
        },
      }),
    );
    maybeAddCompensationObligation(state);
    return;
  }

  if (policy.softLimitUsd !== null && projectedSpendUsd > policy.softLimitUsd) {
    state.obligations.push({
      kind: "spend.warn-threshold",
      policyId: policy.id,
      scope: policy.scope,
      thresholdUsd: policy.softLimitUsd,
      currentSpendUsd,
      projectedSpendUsd,
    });
    state.events.push(
      createSpendEvent({
        type: "spend.BudgetThresholdCrossed",
        request: state.request,
        meteringView: state.meteringView,
        policy,
        currentSpendUsd,
        projectedSpendUsd,
        extra: {
          thresholdUsd: policy.softLimitUsd,
          severity: "soft",
          blocked: false,
        },
      }),
    );
  }
}

function evaluateAgentSpendCap(state, policy, { currentSpendUsd, projectedSpendUsd }) {
  if (policy.spendCapUsd === null || projectedSpendUsd <= policy.spendCapUsd) {
    return;
  }

  state.events.push(
    createSpendEvent({
      type: "spend.CapGateEvaluated",
      request: state.request,
      meteringView: state.meteringView,
      policy,
      currentSpendUsd,
      projectedSpendUsd,
      extra: {
        spendCapUsd: policy.spendCapUsd,
        capExceeded: true,
      },
    }),
  );

  if (!state.approval) {
    state.approvalNeeded.push(policy);
    state.obligations.push({
      kind: "spend.agent-cap-approval",
      policyId: policy.id,
      scope: policy.scope,
      spendCapUsd: policy.spendCapUsd,
      currentSpendUsd,
      projectedSpendUsd,
      allowedApprovers: policy.allowedApprovers,
    });
    return;
  }

  if (state.approval.decision === "denied") {
    state.approvalDenied.push(policy);
    state.violations.push(`${policy.id}: approval denied by ${state.approval.approverId}`);
    return;
  }

  if (policy.allowedApprovers.length > 0 && !policy.allowedApprovers.includes(state.approval.approverId)) {
    state.approvalDenied.push(policy);
    state.violations.push(`${policy.id}: ${state.approval.approverId} is not an allowed approver`);
    return;
  }

  state.approvals.push({
    policyId: policy.id,
    approverId: state.approval.approverId,
    approvedAt: state.approval.approvedAt,
    projectedSpendUsd,
    spendCapUsd: policy.spendCapUsd,
  });
}

function evaluateEstimateDrift(state, policy, { currentSpendUsd, projectedSpendUsd, actualProjectedSpendUsd }) {
  if (state.actualUsd === null || actualProjectedSpendUsd === null) {
    return;
  }

  const driftUsd = roundUsd(state.actualUsd - state.estimateUsd);
  if (driftUsd <= policy.driftToleranceUsd) {
    return;
  }

  const crossedHardAfterActual =
    policy.hardLimitUsd !== null &&
    projectedSpendUsd <= policy.hardLimitUsd &&
    actualProjectedSpendUsd > policy.hardLimitUsd;
  if (!crossedHardAfterActual) {
    return;
  }

  state.driftPolicies.push(policy);
  state.obligations.push({
    kind: "spend.reconcile-estimate-drift",
    policyId: policy.id,
    scope: policy.scope,
    estimatedCostUsd: state.estimateUsd,
    actualCostUsd: state.actualUsd,
    driftUsd,
    currentSpendUsd,
    estimatedProjectedSpendUsd: projectedSpendUsd,
    actualProjectedSpendUsd,
  });
  state.events.push(
    createSpendEvent({
      type: "spend.EstimateDriftObserved",
      request: state.request,
      meteringView: state.meteringView,
      policy,
      currentSpendUsd,
      projectedSpendUsd,
      extra: {
        estimatedCostUsd: state.estimateUsd,
        actualCostUsd: state.actualUsd,
        driftUsd,
        actualProjectedSpendUsd,
        requiresReconciliation: true,
      },
    }),
  );
}

function evaluateCostAvailabilityProfile(state, policy, { currentSpendUsd, projectedSpendUsd }) {
  if (!policy.costAvailabilityProfile) {
    return;
  }

  const profile = policy.costAvailabilityProfile;
  const hoursRemaining = hoursBetween(profile.evaluationAt, profile.periodEnd);
  const projectedPeriodSpendUsd = roundUsd(
    projectedSpendUsd + profile.spendVelocityUsdPerHour * hoursRemaining,
  );
  const breachedTier = profile.tiers.reduce((selected, tier) => {
    if (projectedPeriodSpendUsd <= tier.thresholdUsd) {
      return selected;
    }
    if (!selected || tier.thresholdUsd >= selected.thresholdUsd) {
      return tier;
    }
    return selected;
  }, null);
  if (!breachedTier) {
    return;
  }

  state.degradationPolicies.push(policy);
  state.obligations.push({
    kind: "spend.degradation-required",
    policyId: policy.id,
    scope: policy.scope,
    profileId: profile.id,
    tier: breachedTier.name,
    durable: true,
    strategy: breachedTier.strategy,
    shed: breachedTier.shed,
    currentSpendUsd,
    projectedSpendUsd,
    projectedPeriodSpendUsd,
    thresholdUsd: breachedTier.thresholdUsd,
  });
  state.events.push(
    createSpendEvent({
      type: "spend.DegradationRequired",
      request: state.request,
      meteringView: state.meteringView,
      policy,
      currentSpendUsd,
      projectedSpendUsd,
      extra: {
        profileId: profile.id,
        tier: breachedTier.name,
        durable: true,
        strategy: breachedTier.strategy,
        shed: breachedTier.shed,
        spendVelocityUsdPerHour: profile.spendVelocityUsdPerHour,
        projectedPeriodSpendUsd,
        thresholdUsd: breachedTier.thresholdUsd,
      },
    }),
  );
}

function maybeAddCompensationObligation(state) {
  const partial = state.request.context.partialProvisioning;
  if (!partial || !isJsonObject(partial) || Array.isArray(partial)) {
    return;
  }
  const sagaId = optionalString(partial.sagaId);
  const provisionedResourceIds = parseOptionalStringArray(partial.provisionedResourceIds ?? []);
  if (!sagaId || provisionedResourceIds.length === 0) {
    return;
  }
  if (state.obligations.some((obligation) => obligation.kind === "deployment.compensate")) {
    return;
  }
  state.obligations.push({
    kind: "deployment.compensate",
    reason: "hard budget deny after partial provisioning",
    sagaId,
    provisionedResourceIds,
  });
}

function chooseEffect(state) {
  if (
    state.missingQuotaContext ||
    state.stalePolicies.length > 0 ||
    state.reservationViolations.length > 0 ||
    state.hardViolations.length > 0 ||
    state.approvalDenied.length > 0
  ) {
    return "deny";
  }
  if (state.approvalNeeded.length > 0 || state.driftPolicies.length > 0) {
    return "require-approval";
  }
  if (state.degradationPolicies.length > 0) {
    return "allow-degraded";
  }
  return "allow";
}

function chooseReason(state) {
  if (state.missingQuotaContext) {
    return "missing quota policy context failed closed";
  }
  if (state.stalePolicies.length > 0) {
    return "out-of-order MeteringView update failed closed";
  }
  if (state.reservationViolations.length > 0) {
    return "pre-commit quota reservation denied spend";
  }
  if (state.hardViolations.length > 0) {
    return "hard budget threshold exceeded";
  }
  if (state.approvalDenied.length > 0) {
    return "approval denied for agent spendCapUsd";
  }
  if (state.approvalNeeded.length > 0) {
    return "agent spendCapUsd requires approval";
  }
  if (state.driftPolicies.length > 0) {
    return "estimate-vs-actual drift requires reconciliation approval";
  }
  if (state.degradationPolicies.length > 0) {
    return "spend velocity requires degraded execution";
  }
  return "budget and quota gate passed";
}

function createAuditedPolicyEvent({
  request,
  decision,
  meteringView,
  estimateUsd,
  actualUsd,
  actorId,
  approverId,
  policyIds,
}) {
  return {
    ...createPolicyDecidedEvent({
      request,
      decision,
      id: `policy-decided-${shortHash({ requestHash: request.inputHash, decision })}`,
    }),
    seq: meteringView.seq,
    meteringViewDigest: meteringView.digest,
    audit: {
      actorId,
      approverId,
      meteringViewSeq: meteringView.seq,
      meteringViewDigest: meteringView.digest,
      estimatedCostUsd: estimateUsd,
      actualCostUsd: actualUsd,
      policyIds,
    },
  };
}

function createSpendEvent({ type, request, meteringView, policy, currentSpendUsd, projectedSpendUsd, extra = {} }) {
  const payload = {
    type,
    schemaVersion: BUDGET_QUOTA_POLICY_SCHEMA_VERSION,
    seq: meteringView.seq,
    meteringViewDigest: meteringView.digest,
    policyId: policy.id,
    scopeKind: policy.scope.kind,
    scopeId: policy.scope.id,
    requestHash: request.inputHash,
    currentSpendUsd,
    projectedSpendUsd,
    currency: meteringView.currency,
    ...extra,
  };

  return {
    id: `${type}:${shortHash(payload)}`,
    ...payload,
  };
}

function createQuotaContextMissingEvent({ request, meteringView, estimateUsd, policy = null }) {
  const payload = {
    type: "spend.QuotaContextMissing",
    schemaVersion: BUDGET_QUOTA_POLICY_SCHEMA_VERSION,
    seq: meteringView.seq,
    meteringViewDigest: meteringView.digest,
    requestHash: request.inputHash,
    estimatedCostUsd: estimateUsd,
    currency: meteringView.currency,
    ...(policy
      ? {
          policyId: policy.id,
          scopeKind: policy.scope.kind,
          scopeId: policy.scope.id,
        }
      : undefined),
  };
  return {
    id: `${payload.type}:${shortHash(payload)}`,
    ...payload,
  };
}

function normalizePolicies(policies) {
  if (!Array.isArray(policies)) {
    throw new TypeError("input.policies must be an array");
  }
  return policies.map((policy, index) => normalizePolicy(policy, `input.policies[${index}]`));
}

function normalizePolicy(input, path) {
  const policy = expectObject(input, path);
  const normalized = {
    id: requireString(policy.id, `${path}.id`),
    scope: normalizeScope(policy.scope, `${path}.scope`),
    softLimitUsd: optionalNonNegativeNumber(policy.softLimitUsd, `${path}.softLimitUsd`),
    hardLimitUsd: optionalNonNegativeNumber(policy.hardLimitUsd, `${path}.hardLimitUsd`),
    spendCapUsd: optionalNonNegativeNumber(policy.spendCapUsd, `${path}.spendCapUsd`),
    driftToleranceUsd: optionalNonNegativeNumber(policy.driftToleranceUsd, `${path}.driftToleranceUsd`) ?? 0,
    allowedApprovers: parseStringArray(policy.allowedApprovers ?? [], `${path}.allowedApprovers`),
    lastEvaluatedSeq: optionalNonNegativeInteger(policy.lastEvaluatedSeq, `${path}.lastEvaluatedSeq`) ?? 0,
    reservationRequired: optionalBoolean(policy.reservationRequired, `${path}.reservationRequired`) ?? false,
    costAvailabilityProfile: normalizeCostAvailabilityProfile(
      policy.costAvailabilityProfile,
      `${path}.costAvailabilityProfile`,
      policy.hardLimitUsd,
    ),
  };

  if (
    normalized.softLimitUsd === null &&
    normalized.hardLimitUsd === null &&
    normalized.spendCapUsd === null &&
    normalized.costAvailabilityProfile === null
  ) {
    throw new TypeError(
      `${path} must define a softLimitUsd, hardLimitUsd, spendCapUsd, or costAvailabilityProfile`,
    );
  }
  if (
    normalized.softLimitUsd !== null &&
    normalized.hardLimitUsd !== null &&
    normalized.softLimitUsd >= normalized.hardLimitUsd
  ) {
    throw new RangeError(`${path}.softLimitUsd must be less than hardLimitUsd`);
  }
  return normalized;
}

function normalizeReservation(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const reservation = expectObject(input, "input.reservation");
  return {
    counterId: requireString(reservation.counterId, "input.reservation.counterId"),
    scope: normalizeScope(reservation.scope, "input.reservation.scope"),
    granted: requireBoolean(reservation.granted, "input.reservation.granted"),
    reservedCostUsd: optionalNonNegativeNumber(
      reservation.reservedCostUsd,
      "input.reservation.reservedCostUsd",
    ) ?? 0,
    inFlightActionId: requireString(
      reservation.inFlightActionId,
      "input.reservation.inFlightActionId",
    ),
    reason: optionalString(reservation.reason),
  };
}

function normalizeCostAvailabilityProfile(input, path, fallbackBudgetUsd) {
  if (input === undefined || input === null) {
    return null;
  }
  const profile = expectObject(input, path);
  const budgetUsd =
    optionalNonNegativeNumber(profile.budgetUsd, `${path}.budgetUsd`) ?? fallbackBudgetUsd;
  if (budgetUsd === null || budgetUsd === undefined) {
    throw new TypeError(`${path}.budgetUsd is required when policy.hardLimitUsd is absent`);
  }
  const tiers = parseDegradationTiers(profile.tiers, `${path}.tiers`, budgetUsd);
  return {
    id: requireString(profile.id, `${path}.id`),
    budgetUsd,
    evaluationAt: requireString(profile.evaluationAt, `${path}.evaluationAt`),
    periodEnd: requireString(profile.periodEnd, `${path}.periodEnd`),
    spendVelocityUsdPerHour:
      optionalNonNegativeNumber(
        profile.spendVelocityUsdPerHour,
        `${path}.spendVelocityUsdPerHour`,
      ) ?? 0,
    tiers,
  };
}

function parseDegradationTiers(input, path, budgetUsd) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new TypeError(`${path} must be a non-empty array`);
  }
  return input.map((tier, index) => {
    const tierPath = `${path}[${index}]`;
    const source = expectObject(tier, tierPath);
    const thresholdUsd =
      optionalNonNegativeNumber(source.thresholdUsd, `${tierPath}.thresholdUsd`) ??
      readThresholdFraction(source.thresholdFraction, `${tierPath}.thresholdFraction`, budgetUsd);
    return {
      name: requireString(source.name, `${tierPath}.name`),
      thresholdUsd,
      strategy: requireString(source.strategy, `${tierPath}.strategy`),
      shed: parseStringArray(source.shed ?? [], `${tierPath}.shed`),
    };
  });
}

function normalizeScope(input, path) {
  const scope = expectObject(input, path);
  const kind = requireString(scope.kind, `${path}.kind`);
  if (!SCOPE_KINDS.has(kind)) {
    throw new TypeError(`${path}.kind must be one of ${[...SCOPE_KINDS].join(", ")}`);
  }
  return {
    kind,
    id: requireString(scope.id, `${path}.id`),
  };
}

function sameScope(left, right) {
  return left.kind === right.kind && left.id === right.id;
}

function normalizeMeteringView(input) {
  const view = expectObject(input, "input.meteringView");
  if (view.view !== "MeteringView") {
    throw new TypeError("input.meteringView must be a MeteringView snapshot");
  }
  return {
    ...view,
    seq: requireNonNegativeInteger(view.seq, "input.meteringView.seq"),
    currency: requireString(view.currency, "input.meteringView.currency"),
    digest: requireString(view.digest, "input.meteringView.digest"),
    totalCost: optionalNonNegativeNumber(view.totalCost, "input.meteringView.totalCost") ?? 0,
  };
}

function normalizeApproval(input) {
  if (input === undefined || input === null) {
    return null;
  }
  const approval = expectObject(input, "input.approval");
  const decision = requireString(approval.decision, "input.approval.decision");
  if (!APPROVAL_DECISIONS.has(decision)) {
    throw new TypeError("input.approval.decision must be approved or denied");
  }
  return {
    decision,
    approverId: requireString(approval.approverId, "input.approval.approverId"),
    approvedAt: requireString(approval.approvedAt, "input.approval.approvedAt"),
  };
}

function readScopeSpend(meteringView, scope) {
  const key = `${scope.kind}:${scope.id}`;
  const direct = readCounterValue(meteringView.scopeCosts?.[key]);
  if (direct !== null) {
    return { value: direct, found: true };
  }
  const spendByScope = readCounterValue(meteringView.spendByScope?.[key]);
  if (spendByScope !== null) {
    return { value: spendByScope, found: true };
  }
  const scopeSpendUsd = readCounterValue(meteringView.scopeSpendUsd?.[key]);
  if (scopeSpendUsd !== null) {
    return { value: scopeSpendUsd, found: true };
  }
  if (singlePrincipalScopeMatches(meteringView, scope)) {
    return { value: meteringView.totalCost, found: true };
  }
  return { value: 0, found: false };
}

function readCounterValue(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (Number.isFinite(input) && input >= 0) {
    return roundUsd(input);
  }
  if (isJsonObject(input) && !Array.isArray(input)) {
    for (const key of ["cost", "costUsd", "spendUsd", "value"]) {
      if (Number.isFinite(input[key]) && input[key] >= 0) {
        return roundUsd(input[key]);
      }
    }
  }
  throw new TypeError("metering scope counter must be a non-negative USD number");
}

function singlePrincipalScopeMatches(meteringView, scope) {
  const hierarchyKey =
    scope.kind === "tenant" ? "tenants" : scope.kind === "camp" ? "camps" : "agents";
  const values = meteringView.principalHierarchy?.[hierarchyKey];
  return Array.isArray(values) && values.length === 1 && values[0] === scope.id;
}

function readCost(context, ...keys) {
  const value = keys.map((key) => context?.[key]).find((candidate) => candidate !== undefined);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`request.context.${keys[0]} must be a non-negative number`);
  }
  return roundUsd(value);
}

function readOptionalCost(context, key) {
  if (context?.[key] === undefined || context?.[key] === null) {
    return null;
  }
  if (!Number.isFinite(context[key]) || context[key] < 0) {
    throw new TypeError(`request.context.${key} must be a non-negative number`);
  }
  return roundUsd(context[key]);
}

function readActorId(request) {
  if (isJsonString(request.context.actorId) && request.context.actorId.length > 0) {
    return request.context.actorId;
  }
  if (isJsonString(request.subject.delegatedBy)) {
    return request.subject.delegatedBy;
  }
  if (request.subject.delegatedBy && isJsonObject(request.subject.delegatedBy)) {
    return `${request.subject.delegatedBy.kind}:${request.subject.delegatedBy.id}`;
  }
  return request.subject.id;
}

function expectObject(input, fieldName) {
  if (!input || !isJsonObject(input) || Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  return input;
}

function requireString(input, fieldName) {
  if (!isJsonString(input) || input.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return input;
}

function optionalString(input) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!isJsonString(input) || input.length === 0) {
    return null;
  }
  return input;
}

function parseStringArray(input, fieldName) {
  if (!Array.isArray(input)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return input.map((value, index) => requireString(value, `${fieldName}[${index}]`));
}

function parseOptionalStringArray(input) {
  if (!Array.isArray(input)) {
    return [];
  }
  return input.filter((value) => isJsonString(value) && value.length > 0);
}

function requireBoolean(input, fieldName) {
  if (!isJsonBoolean(input)) {
    throw new TypeError(`${fieldName} must be a boolean`);
  }
  return input;
}

function optionalBoolean(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  return requireBoolean(input, fieldName);
}

function optionalNonNegativeNumber(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  if (!Number.isFinite(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative number`);
  }
  return roundUsd(input);
}

function optionalNonNegativeInteger(input, fieldName) {
  if (input === undefined || input === null) {
    return null;
  }
  return requireNonNegativeInteger(input, fieldName);
}

function requireNonNegativeInteger(input, fieldName) {
  if (!Number.isInteger(input) || input < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return input;
}

function readThresholdFraction(input, fieldName, budgetUsd) {
  if (!Number.isFinite(input) || input <= 0 || input > 1) {
    throw new TypeError(`${fieldName} must be a number greater than 0 and at most 1`);
  }
  return roundUsd(budgetUsd * input);
}

function hoursBetween(start, end) {
  const startMs = Date.parse(start);
  const endMs = Date.parse(end);
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    throw new TypeError("costAvailabilityProfile evaluationAt and periodEnd must be ISO timestamps");
  }
  if (endMs < startMs) {
    throw new RangeError("costAvailabilityProfile.periodEnd must be after evaluationAt");
  }
  return (endMs - startMs) / 3_600_000;
}

function roundUsd(value) {
  return Number(value.toFixed(12));
}

function shortHash(input) {
  return createHash("sha256").update(canonicalJson(input)).digest("hex").slice(0, 16);
}
