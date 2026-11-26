import { isJsonObject } from "./json.js";
import {
  actionProposed,
  handoffRequested,
  policyDecided,
} from "../../crew-event-contract/src/crew-event-contract.js";
import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  classifyRemediationEffect,
  validateRemediationAction,
} from "../../hobo-remediation-action-contract/src/remediation-action-contract.js";
import { classifyFailureSignal } from "../../failure-taxonomy-safe-fix-classifier/src/failure-taxonomy-classifier.js";
import { createSreOperator } from "../../sre-operator-skeleton-contract/src/sre-operator-skeleton.js";
import { diagnoseIncident } from "../../sre-diagnose-projection-contract/src/sre-diagnose-projection.js";

export function decideSreRemediation(input = {}) {
  const decidedAt = input.decidedAt ?? new Date(0).toISOString();
  const diagnosisResult = diagnoseIncident({
    incidentEvents: input.incidentEvents,
    projections: input.projections,
    runbook: input.runbook,
    engine: input.engine,
    diagnosedAt: decidedAt,
    operator: input.operator,
  });

  if (!diagnosisResult.rootCauseEvent) {
    return escalateFromDiagnosisFailure({ diagnosisResult, decidedAt });
  }

  const incidentEvents = [...input.incidentEvents, diagnosisResult.rootCauseEvent];
  const incident = foldIncidentStream(incidentEvents);
  const operator = input.operator ?? createSreOperator();
  const classification = classifyFailureSignal(input.signal);
  const action = actionForSignal(classification, input.signal , input);
  const effect = classifyRemediationEffect(action);
  const branch = branchFor({ classification, effect });
  const reason = branch === "escalate" ? classification.reason : effect.reason;
  const policyDecision = policyDecided({
    id: `policy-sre-${slug(incident.id)}-${slug(branch)}`,
    streamId: `policy:${incident.id}`,
    seq: 1,
    ts: decidedAt,
    effect: branch === "auto-fix" ? "allow" : "require-approval",
  });
  const crewActionProposed = actionProposed({
    id: `crew-action-${slug(incident.id)}`,
    streamId: "crew:sre",
    seq: 2,
    ts: decidedAt,
    principal: operator.principal,
    correlationId: incident.correlationId,
    causationId: diagnosisResult.rootCauseEvent.id,
    action: {
      kind: action.kind,
      target: action.target.id,
    },
    blastRadius: crewBlastRadius(action),
    policyDecisionId: policyDecision.id,
  });
  const incidentRemediationProposed = makeIncidentEvent(INCIDENT_EVENT_TYPES.remediationProposed, {
    id: `incident-remediation-${slug(incident.id)}`,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    causationId: diagnosisResult.rootCauseEvent.id,
    occurredAt: decidedAt,
    payload: {
      actionId: crewActionProposed.id,
      policyDecisionId: policyDecision.id,
      decisionBranch: branch,
      reason,
      action,
      blastRadius: action.blastRadius,
      classification: {
        failureClass: classification.failureClass,
        matchedClasses: [...classification.matchedClasses],
      },
      diagnosis: diagnosisResult.diagnosis.rootCause,
    },
  });
  const handoffRequestedEvent =
    branch === "escalate"
      ? handoffRequested({
          id: `handoff-sre-${slug(incident.id)}`,
          streamId: "crew:sre",
          seq: 3,
          ts: decidedAt,
          principal: operator.principal,
          correlationId: incident.correlationId,
          causationId: crewActionProposed.id,
          target: { kind: "human", name: "on-call" },
          reason: `A2H escalation: ${classification.failureClass} (${reason})`,
        })
      : undefined;

  return deepFreeze({
    branch,
    reason,
    classification,
    action,
    diagnosis: diagnosisResult.diagnosis,
    policyDecision,
    crewActionProposed,
    incidentRemediationProposed,
    handoffRequested: handoffRequestedEvent,
    events: {
      incident: [...incidentEvents, incidentRemediationProposed],
      crew: [policyDecision, crewActionProposed, ...(handoffRequestedEvent ? [handoffRequestedEvent] : [])],
    },
  });
}

export function replaySreDecision(events) {
  const incidentEvents = Array.isArray(events?.incident) ? events.incident : [];
  const remediation = incidentEvents.find((event) => event.type === INCIDENT_EVENT_TYPES.remediationProposed);
  if (!remediation) {
    throw new Error("incident.RemediationProposed event is required for replay");
  }

  const policyDecision = (events?.crew ?? []).find(
    (event) => event.type === "policy.Decided" && event.id === remediation.payload.policyDecisionId,
  );
  if (!policyDecision) {
    throw new Error("matching policy.Decided event is required for replay");
  }

  return deepFreeze({
    branch: remediation.payload.decisionBranch,
    reason: remediation.payload.reason,
    actionKind: remediation.payload.action.kind,
    policyDecisionId: policyDecision.id,
    policyEffect: policyDecision.data.effect,
    classification: remediation.payload.classification,
  });
}

function actionForSignal(classification, signal, input) {
  const source = classification.action;
  const reversible = input.reversible ?? signal.reversible ?? source.blastRadius.reversible;
  const blastRadius = {
    scope: source.blastRadius.scope,
    reversible,
    estimatedImpact: input.estimatedImpact ?? signal.estimatedImpact ?? source.blastRadius.estimatedImpact,
  };

  if (reversible) {
    blastRadius.compensationPath =
      input.compensationPath ?? signal.compensationPath ?? source.blastRadius.compensationPath ?? `${source.kind}:compensate`;
  }

  return validateRemediationAction({
    kind: source.kind,
    target: source.target,
    blastRadius,
    environment: input.environment ?? signal.environment ?? source.environment,
    idempotencyKey: source.idempotencyKey,
    conformanceState: input.conformanceState ?? signal.conformanceState ?? source.conformanceState,
  });
}

function branchFor({ classification, effect }) {
  if (classification.decisionBranch === "escalate") {
    return "escalate";
  }

  if (effect.effectClass === "auto") {
    return "auto-fix";
  }

  return "propose";
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

function escalateFromDiagnosisFailure({ diagnosisResult, decidedAt }) {
  const handoff = diagnosisResult.handoffEvents[0];
  return deepFreeze({
    branch: "escalate",
    reason: diagnosisResult.diagnosis.reason ?? diagnosisResult.diagnosis.status,
    diagnosis: diagnosisResult.diagnosis,
    handoffRequested: handoff,
    events: {
      incident: [],
      crew: handoff ? [handoff] : [],
    },
    decidedAt,
  });
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
