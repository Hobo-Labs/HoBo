/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased event and policy boundary values before remediation decisions. */
import {
  actionApplied,
  actionProposed,
  createOperatorPrincipal,
  foldCrewStream,
  handoffRequested,
  policyDecided,
} from "../../crew-event-contract/src/crew-event-contract.js";
import {
  canaryStrategy,
  createDeploymentStrategySaga,
} from "../../deployment-strategy-saga-templates-contract/src/deployment-strategy-saga-templates.js";
import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  classifyRemediationEffect,
  validateRemediationAction,
} from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";
import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";


export const GATED_REMEDIATION_SCHEMA_VERSION = "hobo.gated-remediation/v1";
export const APPROVAL_OBLIGATION_KIND = "remediation.require-approval";

const DEFAULT_CANARY_PERCENTAGES = Object.freeze([1, 10, 100]);
const AUTO_APPLY_EFFECTS = new Set(["auto", "canary-with-auto-rollback"]);

export async function applyGatedRemediation(input = {}) {
  const action = validateRemediationAction(input.action);
  const decidedAt = validateIso(input.decidedAt ?? new Date(0).toISOString(), "decidedAt");
  const incidentEvents = requiredArray(input.incidentEvents, "incidentEvents");
  const incident = foldIncidentStream(incidentEvents);
  const priorEvents = normalizeEvents(input.priorEvents);
  const operator = input.operator ?? defaultSrePrincipal();

  const loopGuard = findRollbackLoopGuard(priorEvents, action);
  if (loopGuard) {
    const handoff = handoffRequested({
      id: `handoff-loop-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
      streamId: "crew:sre",
      seq: nextCrewSeq(priorEvents.crew),
      ts: decidedAt,
      principal: operator,
      correlationId: incident.correlationId,
      causationId: loopGuard.eventId,
      target: { kind: "human", name: "on-call" },
      reason: `self-caused remediation rollback for ${action.idempotencyKey}; cooldown requires human review`,
    });

    return deepFreeze({
      status: "loop-guarded",
      loopGuard,
      events: { crew: [handoff], incident: [], rollout: [], policy: [] },
    });
  }

  const effect = classifyRemediationEffect(action);
  if (!input.approval && !AUTO_APPLY_EFFECTS.has(effect.effectClass)) {
    const decision = policyDecided({
      id: `policy-${slug(incident.id)}-${slug(action.idempotencyKey)}-hold`,
      streamId: `policy:${incident.id}`,
      seq: nextPolicySeq(priorEvents.crew),
      ts: decidedAt,
      effect: "require-approval",
    });
    const obligation = createApprovalObligation({
      id: `obligation-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
      action,
      incident,
      decidedAt,
      reason: effect.reason,
    });

    return deepFreeze({
      status: "waiting-for-approval",
      reason: effect.reason,
      events: { crew: [decision], incident: [], rollout: [], policy: [obligation] },
    });
  }

  const approvalEvents = input.approval
    ? [createApprovalSatisfied({ priorEvents, action, incident, approval: input.approval })]
    : [];
  const policyDecision = policyDecided({
    id: `policy-${slug(incident.id)}-${slug(action.idempotencyKey)}-allow`,
    streamId: `policy:${incident.id}`,
    seq: nextPolicySeq(priorEvents.crew),
    ts: decidedAt,
    effect: "allow",
  });
  const proposal = actionProposed({
    id: `proposal-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
    streamId: "crew:sre",
    seq: nextCrewSeq(priorEvents.crew),
    ts: decidedAt,
    principal: operator,
    correlationId: incident.correlationId,
    causationId: incident.timeline.at(-1).id,
    action: { kind: action.kind, target: action.target.id },
    blastRadius: blastRadiusFor(action),
    policyDecisionId: policyDecision.id,
  });
  const applied = actionApplied({
    id: `applied-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
    streamId: "crew:sre",
    seq: proposal.seq + 1,
    ts: decidedAt,
    principal: operator,
    correlationId: incident.correlationId,
    causationId: proposal.id,
    proposalId: proposal.id,
    policyDecisionId: policyDecision.id,
  });
  const remediationProposed = makeIncidentEvent(INCIDENT_EVENT_TYPES.remediationProposed, {
    id: `incident-remediation-proposed-${slug(action.idempotencyKey)}`,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    causationId: incident.timeline.at(-1).id,
    occurredAt: decidedAt,
    payload: {
      actionId: proposal.id,
      policyDecisionId: policyDecision.id,
      action,
      approval: input.approval ?? null,
    },
  });

  const rollout = await runLiveFixCanary({ input, action, incident, decidedAt, operator });
  const rolledBack = rollout.events.some((event) => event.type === "rollout.RolledBack");
  const terminalIncident = makeIncidentEvent(
    rolledBack ? INCIDENT_EVENT_TYPES.remediationFailed : INCIDENT_EVENT_TYPES.remediationApplied,
    {
      id: `incident-remediation-${rolledBack ? "failed" : "applied"}-${slug(action.idempotencyKey)}`,
      incidentId: incident.id,
      correlationId: incident.correlationId,
      causationId: remediationProposed.id,
      occurredAt: lastRolloutTime(rollout.events) ?? decidedAt,
      payload: {
        actionId: proposal.id,
        idempotencyKey: action.idempotencyKey,
        rolloutId: rollout.rolloutId,
        result: rolledBack ? "rolled-back" : "applied",
      },
    },
  );
  const handoff = rolledBack
    ? handoffRequested({
        id: `handoff-rollback-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
        streamId: "crew:sre",
        seq: applied.seq + 1,
        ts: terminalIncident.occurredAt,
        principal: operator,
        correlationId: incident.correlationId,
        causationId: terminalIncident.id,
        target: { kind: "human", name: "on-call" },
        reason: `self-caused remediation rollback for ${action.idempotencyKey}`,
      })
    : undefined;

  const events = {
    crew: [policyDecision, proposal, applied, ...(handoff ? [handoff] : [])],
    incident: [...incidentEvents, remediationProposed, terminalIncident],
    rollout: rollout.events,
    policy: [...priorEvents.policy, ...approvalEvents],
  };

  return deepFreeze({
    status: rolledBack ? "rolled-back" : "applied",
    policyDecision,
    proposal,
    applied,
    loopGuard: rolledBack
      ? {
          reason: "rolled-back-remediation-cooldown",
          idempotencyKey: action.idempotencyKey,
          eventId: terminalIncident.id,
        }
      : null,
    events,
  });
}

export function replayGatedRemediation(eventsInput = {}) {
  const events = normalizeEvents(eventsInput);
  const crewReplay = foldCrewStream(events.crew);
  const latestPolicy = [...events.crew].reverse().find((event) => event.type === "policy.Decided");
  const incident = events.incident.length > 0 ? foldIncidentStream(events.incident) : null;
  const rolledBack = events.rollout.some((event) => event.type === "rollout.RolledBack");
  const promoted = events.rollout.some((event) => event.type === "rollout.Promoted");
  const waiting = events.policy.some((event) => event.type === "policy.ObligationCreated");

  return deepFreeze({
    status: rolledBack
      ? "rolled-back"
      : incident?.status === "remediation-applied" || promoted
        ? "applied"
        : waiting
          ? "waiting-for-approval"
          : "unknown",
    policyEffect: latestPolicy?.data.effect,
    incidentStatus: incident?.status,
    crew: crewReplay,
  });
}

async function runLiveFixCanary({ input, action, incident, decidedAt, operator }) {
  const target = {
    service: input.rolloutTarget?.service ?? action.target.id,
    routeId: input.rolloutTarget?.routeId ?? action.target.id,
    fromVersion: input.rolloutTarget?.fromVersion ?? "checkout@stable",
    toVersion: input.rolloutTarget?.toVersion ?? "checkout@live-fix",
  };
  const rolloutId = `rollout-${slug(incident.id)}-${slug(action.idempotencyKey)}`;
  const saga = createDeploymentStrategySaga({ now: sequentialClock(decidedAt) });
  const result = await saga.run({
    rollout: {
      rolloutId,
      runId: `run-${slug(incident.id)}`,
      tenant: input.tenant ?? "tenant-a",
      actor: { kind: "service-account", id: operator.name, tenant: input.tenant ?? "tenant-a" },
      target,
      strategy: canaryStrategy({
        routeId: target.routeId,
        percentages: input.canaryPercentages ?? DEFAULT_CANARY_PERCENTAGES,
        healthGate: input.healthGate ?? { id: `${target.routeId}-health`, timeoutMs: 300000 },
        autoRollbackSignals: input.autoRollbackSignals ?? ["slo-burn", "golden-suite"],
      }),
    },
    gateway: input.gateway,
    gateSignal: input.gateSignal,
  });

  return deepFreeze({ rolloutId, events: result.events, status: result.status });
}

function createApprovalObligation({ id, action, incident, decidedAt, reason }) {
  return deepFreeze({
    id,
    type: "policy.ObligationCreated",
    schemaVersion: GATED_REMEDIATION_SCHEMA_VERSION,
    streamId: `policy-obligation:${incident.id}`,
    data: {
      kind: APPROVAL_OBLIGATION_KIND,
      status: "open",
      incidentId: incident.id,
      correlationId: incident.correlationId,
      actionKind: action.kind,
      target: action.target,
      idempotencyKey: action.idempotencyKey,
      reason,
      requestedAt: decidedAt,
    },
  });
}

function createApprovalSatisfied({ priorEvents, action, incident, approval }) {
  const approvedAt = validateIso(approval.approvedAt, "approval.approvedAt");
  const approvedBy = requiredString(approval.approvedBy, "approval.approvedBy");
  const priorObligation = priorEvents.policy.find(
    (event) =>
      event.type === "policy.ObligationCreated" &&
      event.data?.incidentId === incident.id &&
      event.data?.idempotencyKey === action.idempotencyKey,
  );

  return deepFreeze({
    id: `approval-${slug(incident.id)}-${slug(action.idempotencyKey)}`,
    type: "policy.ObligationSatisfied",
    schemaVersion: GATED_REMEDIATION_SCHEMA_VERSION,
    streamId: priorObligation?.streamId ?? `policy-obligation:${incident.id}`,
    data: {
      kind: APPROVAL_OBLIGATION_KIND,
      status: "satisfied",
      rootObligationId: priorObligation?.id ?? null,
      incidentId: incident.id,
      idempotencyKey: action.idempotencyKey,
      approvedAt,
      approvedBy,
    },
  });
}

function findRollbackLoopGuard(events, action) {
  const failed = [...events.incident].reverse().find(
    (event) =>
      event.type === INCIDENT_EVENT_TYPES.remediationFailed &&
      event.payload?.idempotencyKey === action.idempotencyKey,
  );
  if (!failed) {
    return null;
  }

  return {
    reason: "rolled-back-remediation-cooldown",
    idempotencyKey: action.idempotencyKey,
    eventId: failed.id,
  };
}

function normalizeEvents(input = {}) {
  return {
    crew: Array.isArray(input.crew) ? input.crew : [],
    incident: Array.isArray(input.incident) ? input.incident : [],
    rollout: Array.isArray(input.rollout) ? input.rollout : [],
    policy: Array.isArray(input.policy) ? input.policy : [],
  };
}

function blastRadiusFor(action) {
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

function nextCrewSeq(events) {
  return events
    .filter((event) => isJsonNumber(event.seq) && event.type?.startsWith("crew."))
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function nextPolicySeq(events) {
  return events
    .filter((event) => isJsonNumber(event.seq) && event.type === "policy.Decided")
    .reduce((max, event) => Math.max(max, event.seq), 0) + 1;
}

function sequentialClock(startIso) {
  const start = Date.parse(startIso);
  let tick = 0;
  return () => new Date(start + tick++ * 60_000).toISOString();
}

function lastRolloutTime(events) {
  return [...events].reverse().find((event) => isJsonString(event.time))?.time;
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

function requiredArray(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value;
}

function validateIso(value, fieldName) {
  const text = requiredString(value, fieldName);
  if (Number.isNaN(Date.parse(text))) {
    throw new Error(`${fieldName} must be ISO-8601`);
  }
  return text;
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
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
/* oxlint-disable anti-slop/no-runtime-typeof -- SAFETY: these checks parse erased event and policy boundary values before remediation decisions. */
