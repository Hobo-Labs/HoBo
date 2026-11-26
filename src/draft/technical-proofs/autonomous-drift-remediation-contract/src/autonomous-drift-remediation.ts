import {
  actionProposed,
  createOperatorPrincipal,
  handoffRequested,
  policyDecided,
} from "../../crew-event-contract/src/crew-event-contract.js";
import { classifyFailureSignal } from "../../failure-taxonomy-safe-fix-classifier/src/failure-taxonomy-classifier.js";
import { applyGatedRemediation } from "../../gated-autonomous-remediation-contract/src/gated-autonomous-remediation.js";
import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { validateRemediationAction } from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const AUTONOMOUS_DRIFT_REMEDIATION_VERSION = "hobo.autonomous-drift-remediation/v1";

const knownModes = new Set(["heal", "propose", "ignore"]);

export async function handleResourceDrift(input = {}) {
  const drift = validateDriftSignal(input.drift);
  const policy = resolveDriftPolicy(drift, input.policies);
  const decidedAt = validateIso(input.decidedAt ?? drift.occurredAt, "decidedAt");
  const operator = input.operator?.principal ?? input.operator ?? defaultSrePrincipal();
  const classification = classifyFailureSignal(toFailureSignal(drift, input));
  const incidentEvents = input.incidentEvents ?? createDriftIncidentEvents({ drift, decidedAt });
  const rootCause = incidentEvents.at(-1);

  if (policy.mode === "ignore") {
    const ignored = driftRemediationEvent("drift.Ignored", {
      drift,
      policy,
      decidedAt,
      causationId: rootCause.id,
      payload: {
        reason: policy.reason ?? "resource policy is ignore",
      },
    });

    return freeze({
      status: "ignored",
      mode: policy.mode,
      classification,
      events: {
        incident: incidentEvents,
        crew: [],
        policy: [],
        rollout: [],
        drift: [ignored],
      },
    });
  }

  const action = buildDriftAction({ drift, policy, classification, input });
  const guard = findRepeatDriftGuard({ drift, action, priorEvents: input.priorEvents });
  const budgetDecision = evaluateBlastRadiusBudget(action, input.blastRadiusBudget);

  if (guard || !budgetDecision.allowed) {
    const handoff = handoffRequested({
      id: `handoff-drift-${slug(drift.resourceId)}-${slug(drift.id)}`,
      streamId: "crew:sre",
      seq: nextCrewSeq(input.priorEvents?.crew),
      ts: decidedAt,
      principal: operator,
      correlationId: drift.correlationId,
      causationId: guard?.eventId ?? rootCause.id,
      target: { kind: "human", name: "on-call" },
      reason: guard
        ? `drift remediation loop guard for ${drift.resourceId}`
        : `drift remediation exceeds blast radius budget for ${drift.resourceId}`,
    });
    const escalated = driftRemediationEvent("drift.Escalated", {
      drift,
      policy,
      decidedAt,
      causationId: handoff.id,
      payload: {
        action,
        guard,
        budgetDecision,
      },
    });

    return freeze({
      status: "escalated",
      mode: "escalate",
      classification,
      action,
      guard,
      budgetDecision,
      events: {
        incident: incidentEvents,
        crew: [handoff],
        policy: [],
        rollout: [],
        drift: [escalated],
      },
    });
  }

  if (policy.mode === "propose") {
    return freeze(createDriftProposal({ drift, policy, action, classification, incidentEvents, rootCause, decidedAt, operator }));
  }

  const remediation = await applyGatedRemediation({
    incidentEvents,
    action,
    decidedAt,
    gateway: input.gateway,
    gateSignal: input.gateSignal,
    priorEvents: input.priorEvents,
    rolloutTarget: input.rolloutTarget ?? {
      service: drift.resourceId,
      routeId: drift.resourceId,
      fromVersion: "desired-set@previous",
      toVersion: "desired-set@resync",
    },
    canaryPercentages: input.canaryPercentages,
    healthGate: input.healthGate,
    autoRollbackSignals: input.autoRollbackSignals,
    tenant: drift.tenant,
    operator,
    approval: input.approval,
  });
  const routed = driftRemediationEvent("drift.RemediationRouted", {
    drift,
    policy,
    decidedAt,
    causationId: remediation.proposal?.id ?? rootCause.id,
    payload: {
      action,
      remediationStatus: remediation.status,
      policyDecisionId: remediation.policyDecision?.id,
    },
  });

  return freeze({
    status: remediation.status,
    mode: policy.mode,
    classification,
    action,
    remediation,
    events: {
      ...remediation.events,
      drift: [routed],
    },
  });
}

export function replayDriftRemediation(eventsInput = {}) {
  const driftEvents = Array.isArray(eventsInput.drift) ? eventsInput.drift : [];
  const terminal = driftEvents.at(-1);

  if (!terminal) {
    throw new Error("drift remediation event is required for replay");
  }

  return freeze({
    status: replayStatus(terminal),
    resourceId: terminal.data.resourceId,
    driftId: terminal.data.driftId,
    mode: terminal.data.policy.mode,
    policyDecisionId: terminal.data.policyDecisionId ?? terminal.data.action?.policyDecisionId ?? null,
  });
}

function createDriftProposal({ drift, policy, action, classification, incidentEvents, rootCause, decidedAt, operator }) {
  const policyDecision = policyDecided({
    id: `policy-drift-${slug(drift.resourceId)}-${slug(drift.id)}-proposal`,
    streamId: `policy:${drift.incidentId}`,
    seq: 1,
    ts: decidedAt,
    effect: "require-approval",
  });
  const proposal = actionProposed({
    id: `proposal-drift-${slug(drift.resourceId)}-${slug(drift.id)}`,
    streamId: "crew:sre",
    seq: 2,
    ts: decidedAt,
    principal: operator,
    correlationId: drift.correlationId,
    causationId: rootCause.id,
    action: { kind: "propose", target: drift.resourceId },
    blastRadius: crewBlastRadius(action),
    policyDecisionId: policyDecision.id,
  });
  const proposed = makeIncidentEvent(INCIDENT_EVENT_TYPES.remediationProposed, {
    id: `incident-drift-proposed-${slug(drift.resourceId)}-${slug(drift.id)}`,
    incidentId: drift.incidentId,
    correlationId: drift.correlationId,
    causationId: rootCause.id,
    occurredAt: decidedAt,
    payload: {
      decisionBranch: "propose",
      action,
      classification: {
        failureClass: classification.failureClass,
        matchedClasses: [...classification.matchedClasses],
      },
      policyDecisionId: policyDecision.id,
      diff: {
        desiredSetRef: drift.desiredSetRef,
        observedRef: drift.observedRef,
      },
    },
  });
  const diffOpened = driftRemediationEvent("drift.DiffProposed", {
    drift,
    policy,
    decidedAt,
    causationId: proposal.id,
    payload: {
      action,
      policyDecisionId: policyDecision.id,
      diff: {
        desiredSetRef: drift.desiredSetRef,
        observedRef: drift.observedRef,
      },
    },
  });

  return {
    status: "proposed",
    mode: policy.mode,
    classification,
    action,
    policyDecision,
    proposal,
    events: {
      incident: [...incidentEvents, proposed],
      crew: [policyDecision, proposal],
      policy: [],
      rollout: [],
      drift: [diffOpened],
    },
  };
}

function buildDriftAction({ drift, policy, classification, input }) {
  const estimatedImpact =
    input.estimatedImpact ?? policy.estimatedImpact ?? (policy.mode === "heal" ? "medium" : "high");
  const action = {
    kind: policy.mode === "propose" ? "propose" : classification.action.kind,
    target: { kind: "resource", id: drift.resourceId },
    environment: policy.environment ?? drift.environment ?? "staging",
    idempotencyKey: `drift:${drift.resourceId}:${drift.desiredSetRef}:${drift.observedRef}`,
    conformanceState: input.conformanceState ?? policy.conformanceState ?? "green",
    blastRadius: {
      scope: "resource",
      reversible: true,
      compensationPath: "resync:restore-last-known-good",
      estimatedImpact,
    },
  };

  return validateRemediationAction(action);
}

function createDriftIncidentEvents({ drift, decidedAt }) {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: `incident-open-drift-${slug(drift.id)}`,
    incidentId: drift.incidentId,
    correlationId: drift.correlationId,
    causationId: drift.id,
    occurredAt: drift.occurredAt,
    payload: {
      severity: drift.severity,
      impact: `drift detected on ${drift.resourceId}`,
      causedBy: [{ id: drift.id, type: "resource.DriftDetected", correlationId: drift.correlationId }],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: `incident-triaged-drift-${slug(drift.id)}`,
    incidentId: drift.incidentId,
    correlationId: drift.correlationId,
    causationId: opened.id,
    occurredAt: decidedAt,
    payload: { owner: "operator:sre" },
  });
  const rootCause = makeIncidentEvent(INCIDENT_EVENT_TYPES.rootCauseIdentified, {
    id: `incident-root-drift-${slug(drift.id)}`,
    incidentId: drift.incidentId,
    correlationId: drift.correlationId,
    causationId: triaged.id,
    occurredAt: decidedAt,
    payload: {
      rootCause: "resource drift from desired Set",
      drift: {
        resourceId: drift.resourceId,
        desiredSetRef: drift.desiredSetRef,
        observedRef: drift.observedRef,
      },
    },
  });

  return [opened, triaged, rootCause];
}

function driftRemediationEvent(type, { drift, policy, decidedAt, causationId, payload }) {
  return freeze({
    id: `${type.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${slug(drift.resourceId)}-${slug(drift.id)}`,
    type,
    schemaVersion: AUTONOMOUS_DRIFT_REMEDIATION_VERSION,
    streamId: `drift:${drift.resourceId}`,
    occurredAt: decidedAt,
    correlationId: drift.correlationId,
    causationId,
    data: {
      driftId: drift.id,
      resourceId: drift.resourceId,
      policy,
      ...payload,
    },
  });
}

function findRepeatDriftGuard({ drift, action, priorEvents = {} }) {
  const priorDriftEvents = Array.isArray(priorEvents.drift) ? priorEvents.drift : [];
  const priorForResource = [...priorDriftEvents].reverse().find(
    (event) =>
      event.type === "drift.RemediationRouted" &&
      event.data?.resourceId === drift.resourceId &&
      event.data?.action?.idempotencyKey === action.idempotencyKey,
  );

  if (!priorForResource) {
    return null;
  }

  return freeze({
    reason: "repeated-drift-same-desired-and-observed",
    eventId: priorForResource.id,
    resourceId: drift.resourceId,
    idempotencyKey: action.idempotencyKey,
  });
}

function evaluateBlastRadiusBudget(action, budget) {
  if (!budget) {
    return freeze({ allowed: true, reason: "no-budget-limit" });
  }

  const maxResources = Number.isInteger(budget.maxResources) ? budget.maxResources : 1;
  const requiredResources = action.blastRadius.scope === "resource" ? 1 : 10;
  const allowed = requiredResources <= maxResources && action.blastRadius.estimatedImpact !== "high";

  return freeze({
    allowed,
    maxResources,
    requiredResources,
    reason: allowed ? "inside-blast-radius-budget" : "blast-radius-budget-exceeded",
  });
}

function validateDriftSignal(candidate) {
  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    throw new TypeError("drift signal must be an object");
  }
  if (candidate.type !== "resource.DriftDetected") {
    throw new TypeError("drift.type must be resource.DriftDetected");
  }

  const resourceId = requiredString(candidate.resourceId, "drift.resourceId");
  const id = requiredString(candidate.id, "drift.id");

  return freeze({
    id,
    type: candidate.type,
    resourceId,
    occurredAt: validateIso(candidate.occurredAt ?? new Date(0).toISOString(), "drift.occurredAt"),
    correlationId: candidate.correlationId ?? `corr-${resourceId}`,
    incidentId: candidate.incidentId ?? `incident-drift-${slug(resourceId)}`,
    tenant: candidate.tenant ?? "tenant-a",
    environment: candidate.environment ?? "staging",
    severity: candidate.severity ?? "SEV2",
    desiredSetRef: requiredString(candidate.desiredSetRef, "drift.desiredSetRef"),
    observedRef: requiredString(candidate.observedRef, "drift.observedRef"),
  });
}

function resolveDriftPolicy(drift, policies = {}) {
  const raw = policies[drift.resourceId] ?? policies.default ?? { mode: "propose" };
  const mode = requiredString(raw.mode, "policy.mode");
  if (!knownModes.has(mode)) {
    throw new TypeError(`policy.mode must be one of: ${[...knownModes].join(", ")}`);
  }

  return freeze({
    mode,
    environment: raw.environment,
    estimatedImpact: raw.estimatedImpact,
    conformanceState: raw.conformanceState,
    reason: raw.reason,
  });
}

function toFailureSignal(drift, input) {
  return {
    id: drift.id,
    eventType: drift.type,
    kind: "drift",
    resourceId: drift.resourceId,
    correlationId: drift.correlationId,
    environment: drift.environment,
    conformanceState: input.conformanceState ?? "green",
  };
}

function crewBlastRadius(action) {
  return {
    environment: action.environment,
    maxResources: action.blastRadius.scope === "resource" ? 1 : 10,
    reversible: action.blastRadius.reversible,
  };
}

function nextCrewSeq(events = []) {
  return events
    .filter((event) => isJsonNumber(event.seq) && event.type?.startsWith("crew."))
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function replayStatus(event) {
  if (event.type === "drift.Ignored") return "ignored";
  if (event.type === "drift.DiffProposed") return "proposed";
  if (event.type === "drift.Escalated") return "escalated";
  if (event.type === "drift.RemediationRouted") return event.data.remediationStatus;
  return "unknown";
}

function defaultSrePrincipal() {
  return createOperatorPrincipal({
    name: "SRE",
    svid: "spiffe://yard/acme/agent/sre",
    perAgentPolicy: {
      scopedCapabilities: ["incident:read", "remediation:apply"],
      spendCapUsd: 50,
      requireApprovalGates: ["prod", "destroy", "over-budget"],
    },
    enginePort: "hobo:sre-engine/built-in@0.1.0",
  });
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new TypeError(`${fieldName} must be ISO-8601`);
  }
  return text;
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
  for (const child of Object.values(value)) {
    freeze(child);
  }
  return Object.freeze(value);
}
