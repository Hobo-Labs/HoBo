import {
  actionDenied,
  actionProposed,
  createOperatorPrincipal,
  handoffRequested,
  policyDecided,
  validateCrewEvent,
} from "../../crew-event-contract/src/crew-event-contract.js";
import { validateRemediationAction } from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";
import { isJsonString, isJsonObject } from "./json.js";


export const REMEDIATION_SAFETY_GATE_VERSION = "hobo.remediation-safety-gate/v1";

const APPLY_CAPABILITY = "remediation:apply";
const VALID_SIGNATURE = "valid";

export function evaluateRemediationSafety(input = {}) {
  const signal = validateSignal(input.signal, "signal");
  const corroboratingSignals = validateSignals(input.corroboratingSignals ?? [], "corroboratingSignals");
  const action = validateRemediationAction(input.action);
  const operator = createOperatorPrincipal(input.operator ?? defaultSrePrincipal());
  const rbac = normalizeRbac(input.rbac, operator);
  const priorEvents = normalizeEvents(input.priorEvents);
  const history = foldSafetyHistory(priorEvents);
  const decidedAt = validateIso(input.decidedAt ?? signal.occurredAt, "decidedAt");
  const spend = normalizeSpend({
    ledger: input.spendLedger,
    action,
    operator,
    costEstimateUsd: input.costEstimateUsd ?? 0,
    history,
  });
  const decision = decideSafety({
    signal,
    corroboratingSignals,
    action,
    operator,
    rbac,
    attemptedAllow: input.attemptedAllow,
    history,
    spend,
  });
  const seq = nextCrewSeq(priorEvents.crew);
  const ids = eventIds({ signal, action, decision });
  const policyDecision = policyDecided({
    id: ids.policy,
    streamId: `policy:${signal.correlationId}`,
    seq,
    ts: decidedAt,
    effect: decision.policyEffect,
  });
  const proposal = actionProposed({
    id: ids.proposal,
    streamId: "crew:sre",
    seq: seq + 1,
    ts: decidedAt,
    principal: operator,
    correlationId: signal.correlationId,
    causationId: signal.id,
    action: { kind: action.kind, target: action.target.id },
    blastRadius: crewBlastRadius(action),
    policyDecisionId: policyDecision.id,
  });
  const safety = safetyDecided({
    id: ids.safety,
    signal,
    action,
    operator,
    decision,
    spend,
    policyDecision,
    proposal,
    decidedAt,
  });

  if (decision.status === "allowed") {
    return deepFreeze({
      status: "allowed",
      decision,
      policyDecision,
      proposal,
      events: {
        crew: [policyDecision, proposal],
        safety: [safety],
      },
    });
  }

  const denied = actionDenied({
    id: ids.denied,
    streamId: "crew:sre",
    seq: seq + 2,
    ts: decidedAt,
    principal: operator,
    correlationId: signal.correlationId,
    causationId: proposal.id,
    proposalId: proposal.id,
    policyDecisionId: policyDecision.id,
    reason: decision.reason,
  });
  const handoff =
    decision.status === "escalated"
      ? handoffRequested({
          id: ids.handoff,
          streamId: "crew:sre",
          seq: seq + 3,
          ts: decidedAt,
          principal: operator,
          correlationId: signal.correlationId,
          causationId: denied.id,
          target: { kind: "human", name: "on-call" },
          reason: `A2H escalation: ${decision.reason}`,
        })
      : undefined;

  return deepFreeze({
    status: decision.status,
    decision,
    policyDecision,
    proposal,
    denied,
    handoff,
    events: {
      crew: [policyDecision, proposal, denied, ...(handoff ? [handoff] : [])],
      safety: [safety],
    },
  });
}

export function replayRemediationSafety(eventsInput = {}) {
  const events = normalizeEvents(eventsInput);
  const history = foldSafetyHistory(events);
  const latest = history.records.at(-1);
  if (!latest) {
    throw new Error("remediationSafety.Decided event is required for replay");
  }

  return deepFreeze({
    latestStatus: latest.status,
    latestReason: latest.reason,
    decisions: history.records.length,
    denied: history.records.filter((record) => record.status === "denied").length,
    escalated: history.records.filter((record) => record.status === "escalated").length,
    spendByScope: Object.fromEntries(history.evaluatedSpendByKey),
    crew: events.crew.map(validateCrewEvent),
  });
}

function decideSafety({
  signal,
  corroboratingSignals,
  action,
  operator,
  rbac,
  attemptedAllow,
  history,
  spend,
}) {
  if (history.signalIds.has(signal.id)) {
    return denial({ reason: "signal-replay-detected", spend });
  }

  if (history.actionIdempotencyKeys.has(action.idempotencyKey)) {
    return denial({ reason: "action-idempotency-replay-detected", spend });
  }

  if (!hasValidProvenance(signal)) {
    return denial({ reason: "signal-provenance-invalid", spend });
  }

  if (rbac.subjectId !== operator.svid) {
    return denial({ reason: "rbac-subject-mismatch", spend });
  }

  if (selfAuthorizedWidening({ attemptedAllow, operator, requiredCapability: APPLY_CAPABILITY })) {
    return denial({ reason: "self-authorized-capability-widening", spend });
  }

  if (!operator.perAgentPolicy.scopedCapabilities.includes(APPLY_CAPABILITY)) {
    return denial({ reason: "operator-policy-missing-remediation-apply", spend });
  }

  if (!rbacAllows(rbac, APPLY_CAPABILITY)) {
    return denial({ reason: "rbac-role-missing-remediation-apply", spend });
  }

  if (spend.projectedSpendUsd > spend.capUsd) {
    return denial({
      reason: spend.currentUsd + spend.costEstimateUsd <= spend.capUsd && spend.priorAllowedSpendUsd > 0
        ? "split-spend-cap-exceeded"
        : "spend-cap-exceeded",
      spend,
    });
  }

  if (isDestructive(action) && !hasCorroboration({ signal, corroboratingSignals })) {
    return escalation({ reason: "uncorroborated-destructive-signal", spend });
  }

  return decision({
    status: "allowed",
    policyEffect: "allow",
    reason: "remediation-safety-gate-passed",
    spend,
  });
}

function denial({ reason, spend }) {
  return decision({ status: "denied", policyEffect: "deny", reason, spend });
}

function escalation({ reason, spend }) {
  return decision({ status: "escalated", policyEffect: "require-approval", reason, spend });
}

function decision({ status, policyEffect, reason, spend }) {
  return deepFreeze({
    status,
    policyEffect,
    reason,
    requiredCapability: APPLY_CAPABILITY,
    spendScopeKey: spend.scopeKey,
    windowId: spend.windowId,
    costEstimateUsd: spend.costEstimateUsd,
    currentSpendUsd: spend.currentUsd,
    priorWindowSpendUsd: spend.priorAllowedSpendUsd,
    projectedSpendUsd: spend.projectedSpendUsd,
    capUsd: spend.capUsd,
  });
}

function safetyDecided({
  id,
  signal,
  action,
  operator,
  decision,
  spend,
  policyDecision,
  proposal,
  decidedAt,
}) {
  return deepFreeze({
    id,
    type: "remediationSafety.Decided",
    v: 1,
    ts: decidedAt,
    schemaVersion: REMEDIATION_SAFETY_GATE_VERSION,
    data: {
      status: decision.status,
      reason: decision.reason,
      signalId: signal.id,
      signalSource: signal.source,
      correlationId: signal.correlationId,
      operatorSvid: operator.svid,
      actionKind: action.kind,
      actionTarget: action.target.id,
      idempotencyKey: action.idempotencyKey,
      policyDecisionId: policyDecision.id,
      proposalId: proposal.id,
      spendScopeKey: spend.scopeKey,
      windowId: spend.windowId,
      costEstimateUsd: spend.costEstimateUsd,
      currentSpendUsd: spend.currentUsd,
      priorWindowSpendUsd: spend.priorAllowedSpendUsd,
      projectedSpendUsd: spend.projectedSpendUsd,
      capUsd: spend.capUsd,
    },
  });
}

function foldSafetyHistory(eventsInput = {}) {
  const events = normalizeEvents(eventsInput);
  const records = events.safety.map(validateSafetyEvent);
  const signalIds = new Set(records.map((record) => record.signalId));
  const actionIdempotencyKeys = new Set(records.map((record) => record.idempotencyKey));
  const allowedSpendByKey = new Map();
  const evaluatedSpendByKey = new Map();

  for (const record of records) {
    const key = spendKey(record.spendScopeKey, record.windowId);
    addUsd(evaluatedSpendByKey, key, record.costEstimateUsd);
    if (record.status === "allowed") {
      addUsd(allowedSpendByKey, key, record.costEstimateUsd);
    }
  }

  return deepFreeze({
    records,
    signalIds,
    actionIdempotencyKeys,
    allowedSpendByKey,
    evaluatedSpendByKey,
  });
}

function validateSafetyEvent(event) {
  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    throw new TypeError("remediation safety event must be an object");
  }
  if (event.type !== "remediationSafety.Decided") {
    throw new TypeError(`unsupported remediation safety event: ${event.type}`);
  }
  const data = event.data;
  if (!data || !isJsonObject(data) || Array.isArray(data)) {
    throw new TypeError("remediation safety event data must be an object");
  }

  return deepFreeze({
    id: requiredString(event.id, "safety.id"),
    ts: validateIso(event.ts, "safety.ts"),
    status: requiredString(data.status, "safety.data.status"),
    reason: requiredString(data.reason, "safety.data.reason"),
    signalId: requiredString(data.signalId, "safety.data.signalId"),
    idempotencyKey: requiredString(data.idempotencyKey, "safety.data.idempotencyKey"),
    spendScopeKey: requiredString(data.spendScopeKey, "safety.data.spendScopeKey"),
    windowId: requiredString(data.windowId, "safety.data.windowId"),
    costEstimateUsd: validateNonNegativeNumber(data.costEstimateUsd, "safety.data.costEstimateUsd"),
  });
}

function normalizeSpend({ ledger, action, operator, costEstimateUsd, history }) {
  const source = ledger && isJsonObject(ledger) && !Array.isArray(ledger) ? ledger : {};
  const currentUsd = validateNonNegativeNumber(source.currentUsd ?? 0, "spendLedger.currentUsd");
  const actionCostUsd = validateNonNegativeNumber(costEstimateUsd, "costEstimateUsd");
  const operatorCapUsd = validateNonNegativeNumber(operator.perAgentPolicy.spendCapUsd, "operator.spendCapUsd");
  const ledgerCapUsd = source.capUsd === undefined
    ? operatorCapUsd
    : validateNonNegativeNumber(source.capUsd, "spendLedger.capUsd");
  const capUsd = Math.min(operatorCapUsd, ledgerCapUsd);
  const scopeKey = source.scopeKey
    ? requiredString(source.scopeKey, "spendLedger.scopeKey")
    : `${action.target.kind}:${action.target.id}`;
  const windowId = source.windowId ? requiredString(source.windowId, "spendLedger.windowId") : "default";
  const priorAllowedSpendUsd = history.allowedSpendByKey.get(spendKey(scopeKey, windowId)) ?? 0;

  return deepFreeze({
    currentUsd,
    costEstimateUsd: actionCostUsd,
    capUsd,
    scopeKey,
    windowId,
    priorAllowedSpendUsd,
    projectedSpendUsd: roundUsd(currentUsd + priorAllowedSpendUsd + actionCostUsd),
  });
}

function normalizeRbac(input, operator) {
  const source = input && isJsonObject(input) && !Array.isArray(input) ? input : {};
  const subjectId = source.subjectId ? requiredString(source.subjectId, "rbac.subjectId") : operator.svid;
  const roleBindings = source.roleBindings?.[subjectId] ?? [];
  return deepFreeze({
    subjectId,
    roles: normalizeStringList(source.roles ?? roleBindings, "rbac.roles"),
    roleGrants: Object.fromEntries(
      Object.entries(source.roleGrants ?? {}).map(([role, grants]) => [
        requiredString(role, "rbac.roleGrants role"),
        normalizeStringList(grants, `rbac.roleGrants.${role}`),
      ]),
    ),
  });
}

function rbacAllows(rbac, capability) {
  return rbac.roles.some((role) => rbac.roleGrants[role]?.includes(capability));
}

function selfAuthorizedWidening({ attemptedAllow, operator, requiredCapability }) {
  if (!attemptedAllow || !isJsonObject(attemptedAllow) || Array.isArray(attemptedAllow)) {
    return false;
  }

  const actorId = attemptedAllow.actorId ? requiredString(attemptedAllow.actorId, "attemptedAllow.actorId") : "";
  if (actorId !== operator.svid && actorId !== operator.name) {
    return false;
  }

  const attemptedCapabilities = normalizeStringList(
    attemptedAllow.scopedCapabilities ?? [],
    "attemptedAllow.scopedCapabilities",
  );
  const baseline = new Set(operator.perAgentPolicy.scopedCapabilities);
  return attemptedCapabilities.includes(requiredCapability) && !baseline.has(requiredCapability);
}

function hasCorroboration({ signal, corroboratingSignals }) {
  return corroboratingSignals.some(
    (candidate) => hasValidProvenance(candidate) && candidate.source !== signal.source,
  );
}

function hasValidProvenance(signal) {
  return signal.provenance.signature === VALID_SIGNATURE && signal.provenance.issuer.startsWith("spiffe://");
}

function isDestructive(action) {
  return (
    action.environment === "prod" ||
    !action.blastRadius.reversible ||
    action.blastRadius.estimatedImpact !== "low"
  );
}

function validateSignals(values, fieldName) {
  if (!Array.isArray(values)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return values.map((value, index) => validateSignal(value, `${fieldName}[${index}]`));
}

function validateSignal(candidate, fieldName) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError(`${fieldName} must be an object`);
  }
  const provenance = candidate.provenance && isJsonObject(candidate.provenance)
    ? candidate.provenance
    : {};

  return deepFreeze({
    id: requiredString(candidate.id, `${fieldName}.id`),
    type: requiredString(candidate.type, `${fieldName}.type`),
    correlationId: requiredString(candidate.correlationId, `${fieldName}.correlationId`),
    targetId: requiredString(candidate.targetId, `${fieldName}.targetId`),
    source: requiredString(candidate.source, `${fieldName}.source`),
    occurredAt: validateIso(candidate.occurredAt, `${fieldName}.occurredAt`),
    severity: candidate.severity ? requiredString(candidate.severity, `${fieldName}.severity`) : "unknown",
    provenance: {
      issuer: requiredString(provenance.issuer, `${fieldName}.provenance.issuer`),
      signature: requiredString(provenance.signature, `${fieldName}.provenance.signature`),
    },
  });
}

function normalizeEvents(input = {}) {
  return {
    crew: Array.isArray(input.crew) ? input.crew : [],
    safety: Array.isArray(input.safety) ? input.safety : [],
  };
}

function eventIds({ signal, action, decision }) {
  const base = `${slug(signal.id)}-${slug(action.idempotencyKey)}-${slug(decision.reason)}`;
  return {
    policy: `policy-safety-${base}`,
    proposal: `proposal-safety-${base}`,
    denied: `denied-safety-${base}`,
    handoff: `handoff-safety-${base}`,
    safety: `remediation-safety-${base}`,
  };
}

function crewBlastRadius(action) {
  return {
    environment: action.environment,
    maxResources: maxResourcesFor(action.blastRadius.scope),
    reversible: action.blastRadius.reversible,
  };
}

function maxResourcesFor(scope) {
  if (scope === "resource") return 1;
  if (scope === "camp") return 10;
  return 50;
}

function nextCrewSeq(events = []) {
  return events
    .filter((event) => Number.isSafeInteger(event.seq))
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function defaultSrePrincipal() {
  return {
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "remediation:propose", "remediation:apply"],
      spendCapUsd: 50,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  };
}

function addUsd(map, key, amount) {
  map.set(key, roundUsd((map.get(key) ?? 0) + amount));
}

function spendKey(scopeKey, windowId) {
  return `${scopeKey}|${windowId}`;
}

function normalizeStringList(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${fieldName} must be an array`);
  }
  return [...new Set(value.map((entry) => requiredString(entry, fieldName)))].sort();
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function validateNonNegativeNumber(value, fieldName) {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${fieldName} must be non-negative`);
  }
  return roundUsd(value);
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${fieldName} is required`);
  }
  return value.trim();
}

function roundUsd(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  if (value instanceof Map || value instanceof Set) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
