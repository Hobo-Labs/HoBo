import {
  actionApplied,
  actionDenied,
  actionProposed,
  createOperatorPrincipal,
  handoffRequested,
  policyDecided,
  validateCrewEvent,
} from "../../crew-event-contract/src/crew-event-contract.js";
import { validateRemediationAction } from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const RUNAWAY_REMEDIATION_GUARD_VERSION = "hobo.runaway-remediation-guard/v1";

const DEFAULT_SELF_CAUSED_CYCLES = 2;
const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const DEFAULT_MAX_ACTIONS_PER_WINDOW = 1;
const circuitOpeningReasons = new Set([
  "self-causation-circuit-breaker",
  "cross-operator-causation-loop",
  "outage-amplification",
  "blast-radius-widening",
  "circuit-breaker-open",
]);
const impactRank = Object.freeze({ low: 1, medium: 2, high: 3 });
const severityRank = Object.freeze({ SEV4: 1, SEV3: 2, SEV2: 3, SEV1: 4 });

export function evaluateRunawayRemediation(input = {}) {
  const signal = validateSignal(input.signal);
  const action = validateRemediationAction(input.action);
  const decidedAt = validateIso(input.decidedAt ?? signal.occurredAt, "decidedAt");
  const operator = createOperatorPrincipal(input.operator ?? defaultSrePrincipal());
  const priorEvents = normalizeEvents(input.priorEvents);
  const history = foldGuardHistory(priorEvents);
  const maxSelfCausedCycles = validatePositiveInteger(
    input.maxSelfCausedCycles ?? DEFAULT_SELF_CAUSED_CYCLES,
    "maxSelfCausedCycles",
  );
  const cooldownMs = validateNonNegativeInteger(input.cooldownMs ?? DEFAULT_COOLDOWN_MS, "cooldownMs");
  const rateLimitWindowMs = validateNonNegativeInteger(
    input.rateLimitWindowMs ?? DEFAULT_RATE_LIMIT_WINDOW_MS,
    "rateLimitWindowMs",
  );
  const maxActionsPerWindow = validatePositiveInteger(
    input.maxActionsPerWindow ?? DEFAULT_MAX_ACTIONS_PER_WINDOW,
    "maxActionsPerWindow",
  );
  const context = {
    signal,
    action,
    operator,
    history,
    decidedAt,
    maxSelfCausedCycles,
    cooldownMs,
    rateLimitWindowMs,
    maxActionsPerWindow,
    blastRadiusCap: input.blastRadiusCap,
  };
  const decision = decideGuard(context);
  const seq = nextCrewSeq(priorEvents.crew);
  const policyDecision = policyDecided({
    id: `policy-runaway-${slug(signal.id)}-${slug(action.idempotencyKey)}-${decision.reason}`,
    streamId: `policy:${signal.correlationId}`,
    seq,
    ts: decidedAt,
    effect: decision.allowsApply ? "allow" : "deny",
  });
  const proposal = actionProposed({
    id: `proposal-runaway-${slug(signal.id)}--${slug(action.idempotencyKey)}`,
    streamId: "crew:sre",
    seq: seq + 1,
    ts: decidedAt,
    principal: operator,
    correlationId: signal.correlationId,
    causationId: signal.causedByActionId ?? signal.id,
    action: { kind: action.kind, target: action.target.id },
    blastRadius: crewBlastRadius(action),
    policyDecisionId: policyDecision.id,
  });

  if (decision.allowsApply) {
    const applied = actionApplied({
      id: `applied-runaway-${slug(signal.id)}-${slug(action.idempotencyKey)}`,
      streamId: "crew:sre",
      seq: seq + 2,
      ts: decidedAt,
      principal: operator,
      correlationId: signal.correlationId,
      causationId: proposal.id,
      proposalId: proposal.id,
      policyDecisionId: policyDecision.id,
    });
    const guard = guardEvent({
      signal,
      action,
      operator,
      decidedAt,
      proposal,
      terminal: applied,
      decision,
    });

    return freeze({
      status: "applied",
      guard,
      policyDecision,
      proposal,
      applied,
      events: {
        crew: [policyDecision, proposal, applied],
      },
    });
  }

  const denied = actionDenied({
    id: `denied-runaway-${slug(signal.id)}-${slug(action.idempotencyKey)}`,
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
  const handoff = decision.escalates
    ? handoffRequested({
        id: `handoff-runaway-${slug(signal.id)}-${slug(action.idempotencyKey)}`,
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
  const guard = guardEvent({
    signal,
    action,
    operator,
    decidedAt,
    proposal,
    terminal: denied,
    decision,
    handoff,
  });

  return freeze({
    status: decision.escalates ? "escalated" : "cooldown",
    guard,
    policyDecision,
    proposal,
    denied,
    handoff,
    events: {
      crew: [policyDecision, proposal, denied, ...(handoff ? [handoff] : [])],
    },
  });
}

export function replayRunawayGuard(eventsInput = {}) {
  const events = normalizeEvents(eventsInput);
  const records = foldGuardHistory(events).records;
  const latest = records.at(-1);

  if (!latest) {
    throw new Error("crew guard decision event is required for replay");
  }

  return freeze({
    status: latest.decision,
    reason: latest.reason,
    appliedActions: records.filter((record) => record.decision === "applied").length,
    deniedActions: records.filter((record) => record.decision !== "applied").length,
    circuitOpenScopes: records
      .filter((record) => record.decision === "escalated")
      .map((record) => record.scopeKey),
  });
}

function decideGuard({
  signal,
  action,
  operator,
  history,
  decidedAt,
  maxSelfCausedCycles,
  cooldownMs,
  rateLimitWindowMs,
  maxActionsPerWindow,
  blastRadiusCap,
}) {
  const scopeKey = scopeKeyFor(action);
  const proposedBlastRadius = blastRadiusSummary(action);
  const sourceRecord = findSourceAction(history, signal.causedByActionId);
  const openCircuit = findOpenCircuit(history, scopeKey);
  if (openCircuit) {
    return escalation({
      reason: "circuit-breaker-open",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: openCircuit.blastRadius,
      sourceActionId: signal.causedByActionId,
    });
  }

  const amplified = findAmplification({ signal, sourceRecord, proposedBlastRadius });
  if (amplified) {
    return escalation({
      reason: "outage-amplification",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: amplified.previousBlastRadius,
      sourceActionId: signal.causedByActionId,
    });
  }

  const priorBlastRadius = findPriorBlastRadius(history, scopeKey, blastRadiusCap, sourceRecord);
  if (priorBlastRadius && isBlastRadiusWidening(proposedBlastRadius, priorBlastRadius)) {
    return escalation({
      reason: "blast-radius-widening",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: priorBlastRadius,
      sourceActionId: signal.causedByActionId,
    });
  }

  const crossOperatorLoop = findCrossOperatorLoop({ history, sourceRecord, operatorName: operator.name });
  if (crossOperatorLoop) {
    return escalation({
      reason: "cross-operator-causation-loop",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: sourceRecord?.blastRadius ?? null,
      sourceActionId: signal.causedByActionId,
      loopOperators: crossOperatorLoop.loopOperators,
    });
  }

  if (sourceRecord && (sourceRecord.operatorName === operator.name || sourceRecord.scopeKey === scopeKey)) {
    const cycle = selfCausedCycleCount(history, scopeKey) + 1;
    if (cycle >= maxSelfCausedCycles) {
      return escalation({
        reason: "self-causation-circuit-breaker",
        scopeKey,
        proposedBlastRadius,
        previousBlastRadius: sourceRecord.blastRadius,
        sourceActionId: signal.causedByActionId,
        selfCausedCycle: cycle,
      });
    }

    return denial({
      reason: "self-causation-cooldown",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: sourceRecord.blastRadius,
      sourceActionId: signal.causedByActionId,
      selfCausedCycle: cycle,
    });
  }

  const cooldown = findCooldown({ history, action, decidedAt, cooldownMs });
  if (cooldown) {
    return denial({
      reason: "action-cooldown",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: cooldown.blastRadius,
      sourceActionId: signal.causedByActionId,
    });
  }

  const rateLimit = findActionRateLimit({
    history,
    action,
    scopeKey,
    decidedAt,
    rateLimitWindowMs,
    maxActionsPerWindow,
  });
  if (rateLimit) {
    return denial({
      reason: "action-rate-limit",
      scopeKey,
      proposedBlastRadius,
      previousBlastRadius: rateLimit.blastRadius,
      sourceActionId: signal.causedByActionId,
    });
  }

  return allow({ scopeKey, proposedBlastRadius, sourceActionId: signal.causedByActionId });
}

function allow({ scopeKey, proposedBlastRadius, sourceActionId }) {
  return freeze({
    allowsApply: true,
    escalates: false,
    decision: "applied",
    reason: "inside-runaway-guard",
    scopeKey,
    proposedBlastRadius,
    previousBlastRadius: null,
    sourceActionId,
  });
}

function denial({
  reason,
  scopeKey,
  proposedBlastRadius,
  previousBlastRadius,
  sourceActionId,
  selfCausedCycle = 0,
}) {
  return freeze({
    allowsApply: false,
    escalates: false,
    decision: "cooldown",
    reason,
    scopeKey,
    proposedBlastRadius,
    previousBlastRadius,
    sourceActionId,
    selfCausedCycle,
  });
}

function escalation({
  reason,
  scopeKey,
  proposedBlastRadius,
  previousBlastRadius,
  sourceActionId,
  selfCausedCycle = 0,
  loopOperators = [],
}) {
  return freeze({
    allowsApply: false,
    escalates: true,
    decision: "escalated",
    reason,
    scopeKey,
    proposedBlastRadius,
    previousBlastRadius,
    sourceActionId,
    selfCausedCycle,
    loopOperators,
  });
}

function guardEvent({ signal, action, operator, proposal, terminal, decision, handoff }) {
  const appliedActionId = terminal.type === "crew.ActionApplied" ? terminal.id : null;
  const deniedActionId = terminal.type === "crew.ActionDenied" ? terminal.id : null;

  return freeze({
    schemaVersion: RUNAWAY_REMEDIATION_GUARD_VERSION,
    decision: decision.decision,
    reason: decision.reason,
    signalId: signal.id,
    sourceActionId: decision.sourceActionId ?? null,
    operatorName: operator.name,
    action: {
      kind: action.kind,
      target: action.target.id,
      idempotencyKey: action.idempotencyKey,
    },
    scopeKey: decision.scopeKey,
    proposalId: proposal.id,
    terminalActionId: terminal.id,
    appliedActionId,
    deniedActionId,
    handoffId: handoff?.id ?? null,
    proposedBlastRadius: decision.proposedBlastRadius,
    previousBlastRadius: decision.previousBlastRadius,
    selfCausedCycle: decision.selfCausedCycle ?? 0,
    loopOperators: decision.loopOperators ?? [],
  });
}

function foldGuardHistory(priorEvents) {
  const crew = priorEvents.crew.map(validateCrewEvent);
  const proposals = new Map();
  const handoffsByCausation = new Map();
  const terminalEvents = [];

  for (const event of crew) {
    if (event.type === "crew.ActionProposed") {
      proposals.set(event.id, event);
    }
    if (event.type === "crew.ActionApplied" || event.type === "crew.ActionDenied") {
      terminalEvents.push(event);
    }
    if (event.type === "crew.HandoffRequested" && event.causationId) {
      handoffsByCausation.set(event.causationId, event);
    }
  }

  const actionById = new Map();
  const actionsByScope = new Map();
  const actionsByKey = new Map();
  const records = [];

  for (const event of terminalEvents) {
    const proposal = proposals.get(event.data.proposalId);
    if (!proposal) continue;
    const handoff = handoffsByCausation.get(event.id);
    const isEscalated = event.type === "crew.ActionDenied" && handoff;
    const record = {
      eventId: event.id,
      proposalId: proposal.id,
      terminalActionId: event.id,
      appliedActionId: event.type === "crew.ActionApplied" ? event.id : null,
      deniedActionId: event.type === "crew.ActionDenied" ? event.id : null,
      sourceActionId: proposal.causationId ?? null,
      operatorName: proposal.principal.name,
      actionKind: proposal.data.action.kind,
      actionTarget: proposal.data.action.target,
      idempotencyKey: idempotencyKeyFromProposal(proposal),
      scopeKey: scopeKeyFromProposal(proposal),
      decision: event.type === "crew.ActionApplied" ? "applied" : isEscalated ? "escalated" : "cooldown",
      reason: event.type === "crew.ActionApplied" ? "inside-runaway-guard" : event.data.reason,
      occurredAt: event.ts,
      blastRadius: blastRadiusFromCrew(proposal.data.blastRadius),
    };

    for (const id of [record.terminalActionId, record.appliedActionId, record.deniedActionId, record.proposalId]) {
      if (id) actionById.set(id, record);
    }
    if (!actionsByScope.has(record.scopeKey)) actionsByScope.set(record.scopeKey, []);
    actionsByScope.get(record.scopeKey).push(record);
    actionsByKey.set(`${record.scopeKey}:${record.idempotencyKey}`, record);
    records.push(record);
  }

  return freeze({
    crew,
    records,
    actionById,
    actionsByScope,
    actionsByKey,
  });
}

function findSourceAction(history, sourceActionId) {
  if (!sourceActionId) return null;
  return history.actionById.get(sourceActionId) ?? null;
}

function findAmplification({ signal, sourceRecord, proposedBlastRadius }) {
  const observed = signal.observedEffect;
  if (!observed) return null;

  const severityBefore = severityRank[observed.severityBefore] ?? 0;
  const severityAfter = severityRank[observed.severityAfter] ?? 0;
  const previousBlastRadius = sourceRecord?.blastRadius ?? proposedBlastRadius;
  const observedBlastRadius = observed.blastRadiusAfter
    ? blastRadiusSummaryFromParts(observed.blastRadiusAfter)
    : null;
  const blastRadiusAmplified =
    observedBlastRadius && isBlastRadiusWidening(observedBlastRadius, previousBlastRadius);

  if (severityAfter > severityBefore || blastRadiusAmplified) {
    return { previousBlastRadius };
  }

  return null;
}

function findOpenCircuit(history, scopeKey) {
  const opened = (history.actionsByScope.get(scopeKey) ?? []).find(
    (record) => record.decision === "escalated" && circuitOpeningReasons.has(record.reason),
  );
  return opened ?? null;
}

function findPriorBlastRadius(history, scopeKey, explicitCap, sourceRecord) {
  if (explicitCap) return blastRadiusSummaryFromParts(explicitCap);

  if (sourceRecord) {
    const causalChain = [sourceRecord, ...actionAncestors(history, sourceRecord)].filter(
      (record) => record.decision === "applied",
    );
    if (causalChain.length > 0) {
      return causalChain.reduce(
        (cap, record) => (cap ? mostRestrictiveBlastRadius(cap, record.blastRadius) : record.blastRadius),
        null,
      );
    }
  }

  const applied = (history.actionsByScope.get(scopeKey) ?? []).filter(
    (record) => record.decision === "applied",
  );
  return applied.reduce(
    (cap, record) => (cap ? mostRestrictiveBlastRadius(cap, record.blastRadius) : record.blastRadius),
    null,
  );
}

function isBlastRadiusWidening(proposed, previous) {
  return proposed.maxResources > previous.maxResources;
}

function mostRestrictiveBlastRadius(left, right) {
  return freeze({
    scope: left.maxResources <= right.maxResources ? left.scope : right.scope,
    maxResources: Math.min(left.maxResources, right.maxResources),
    estimatedImpact: "unknown",
    impactRank: 0,
  });
}

function findCrossOperatorLoop({ history, sourceRecord, operatorName }) {
  if (!sourceRecord || sourceRecord.operatorName === operatorName) {
    return null;
  }

  const ancestors = actionAncestors(history, sourceRecord);
  const closesLoop = ancestors.some((record) => record.operatorName === operatorName);
  if (!closesLoop) {
    return null;
  }

  return freeze({
    loopOperators: [operatorName, sourceRecord.operatorName],
  });
}

function actionAncestors(history, record) {
  const ancestors = [];
  const seen = new Set();
  let current = record;

  while (current && current.sourceActionId && !seen.has(current.sourceActionId)) {
    seen.add(current.sourceActionId);
    current = history.actionById.get(current.sourceActionId);
    if (current) ancestors.push(current);
  }

  return ancestors;
}

function selfCausedCycleCount(history, scopeKey) {
  return (history.actionsByScope.get(scopeKey) ?? []).filter((record) =>
    record.reason.startsWith("self-causation-"),
  ).length;
}

function findCooldown({ history, action, decidedAt, cooldownMs }) {
  if (cooldownMs === 0) return null;

  const scopeKey = scopeKeyFor(action);
  const prior = history.actionsByKey.get(`${scopeKey}:${slug(action.idempotencyKey)}`);
  if (!prior || prior.decision !== "applied") return null;

  const elapsed = Date.parse(decidedAt) - Date.parse(prior.occurredAt);
  return elapsed >= 0 && elapsed < cooldownMs ? prior : null;
}

function findActionRateLimit({
  history,
  action,
  scopeKey,
  decidedAt,
  rateLimitWindowMs,
  maxActionsPerWindow,
}) {
  if (rateLimitWindowMs === 0) return null;

  const windowStart = Date.parse(decidedAt) - rateLimitWindowMs;
  const applied = (history.actionsByScope.get(scopeKey) ?? []).filter((record) => {
    if (record.decision !== "applied" || record.actionKind !== action.kind) return false;
    const occurredAt = Date.parse(record.occurredAt);
    return occurredAt >= windowStart && occurredAt <= Date.parse(decidedAt);
  });

  return applied.length >= maxActionsPerWindow ? applied.at(-1) : null;
}

function validateSignal(candidate) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError("signal must be an object");
  }

  return freeze({
    id: requiredString(candidate.id, "signal.id"),
    type: requiredString(candidate.type, "signal.type"),
    correlationId: requiredString(candidate.correlationId, "signal.correlationId"),
    targetId: requiredString(candidate.targetId, "signal.targetId"),
    occurredAt: validateIso(candidate.occurredAt ?? new Date(0).toISOString(), "signal.occurredAt"),
    severity: candidate.severity ?? "unknown",
    causedByActionId:
      candidate.causedByActionId === undefined
        ? null
        : requiredString(candidate.causedByActionId, "signal.causedByActionId"),
    observedEffect: validateObservedEffect(candidate.observedEffect),
  });
}

function validateObservedEffect(candidate) {
  if (candidate === undefined) return null;
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError("signal.observedEffect must be an object");
  }

  return freeze({
    severityBefore: candidate.severityBefore ?? "unknown",
    severityAfter: candidate.severityAfter ?? "unknown",
    blastRadiusAfter: candidate.blastRadiusAfter ? blastRadiusSummaryFromParts(candidate.blastRadiusAfter) : null,
  });
}

function normalizeEvents(input = {}) {
  return {
    crew: Array.isArray(input.crew) ? input.crew : [],
  };
}

function crewBlastRadius(action) {
  const summary = blastRadiusSummary(action);
  return {
    environment: action.environment,
    maxResources: summary.maxResources,
    reversible: action.blastRadius.reversible,
  };
}

function blastRadiusSummary(action) {
  return blastRadiusSummaryFromParts(action.blastRadius);
}

function blastRadiusSummaryFromParts(blastRadius) {
  const scope = requiredString(blastRadius.scope, "blastRadius.scope");
  const estimatedImpact = requiredString(blastRadius.estimatedImpact, "blastRadius.estimatedImpact");

  return freeze({
    scope,
    maxResources: maxResourcesFor(scope),
    estimatedImpact,
    impactRank: impactRank[estimatedImpact] ?? 99,
  });
}

function blastRadiusFromCrew(blastRadius) {
  const maxResources = validatePositiveInteger(blastRadius.maxResources, "blastRadius.maxResources");
  return freeze({
    scope: scopeFromMaxResources(maxResources),
    maxResources,
    estimatedImpact: "unknown",
    impactRank: 0,
  });
}

function maxResourcesFor(scope) {
  if (scope === "resource") return 1;
  if (scope === "camp") return 10;
  return 50;
}

function scopeFromMaxResources(maxResources) {
  if (maxResources <= 1) return "resource";
  if (maxResources <= 10) return "camp";
  return "region";
}

function scopeKeyFor(action) {
  return `${action.environment}:${action.target.id}`;
}

function scopeKeyFromProposal(proposal) {
  return `${proposal.data.blastRadius.environment}:${proposal.data.action.target}`;
}

function idempotencyKeyFromProposal(proposal) {
  return proposal.id.split("--").at(-1) || proposal.id;
}

function nextCrewSeq(events = []) {
  return events
    .filter((event) => isJsonNumber(event.seq))
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function defaultSrePrincipal() {
  return {
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "remediation:apply"],
      spendCapUsd: 50,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  };
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${fieldName} must be ISO-8601`);
  }
  return text;
}

function validatePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${fieldName} must be a positive safe integer`);
  }
  return value;
}

function validateNonNegativeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new TypeError(`${fieldName} is required`);
  }
  return value.trim();
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function freeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  if (value instanceof Map || value instanceof Set) {
    return value;
  }
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}
