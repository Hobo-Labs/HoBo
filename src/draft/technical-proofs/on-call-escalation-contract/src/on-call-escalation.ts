import { handoffRequested } from "../../crew-event-contract/src/crew-event-contract.js";
import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { createSreOperator } from "../../sre-operator-skeleton-contract/src/sre-operator-skeleton.js";
import { isJsonString, isJsonObject } from "./json.js";


export const ON_CALL_ESCALATION_SCHEMA_VERSION = "hobo.on-call-escalation/v1";
export const ON_CALL_ACK_OBLIGATION_KIND = "incident.on-call-ack-deadline";
export const NOTIFY_PORT = "hobo:notify";

const HUMAN_DECISIONS = new Set(["apply-fix", "re-bless", "abort"]);

const DEFAULT_ESCALATION_LADDER = Object.freeze([
  Object.freeze({
    kind: "human",
    name: "primary-on-call",
    provider: "pagerduty-adapter-stub",
  }),
  Object.freeze({
    kind: "human",
    name: "secondary-on-call",
    provider: "opsgenie-adapter-stub",
  }),
  Object.freeze({
    kind: "human",
    name: "incident-commander",
    provider: "slack-adapter-stub",
  }),
]);

export function createOnCallEscalation(input = {}) {
  const incident = foldIncidentStream(requiredArray(input.incidentEvents, "incidentEvents"));
  const requestedAt = validateIso(input.requestedAt ?? new Date(0).toISOString(), "requestedAt");
  const ladder = normalizeLadder(input.ladder ?? DEFAULT_ESCALATION_LADDER);
  const receiver = ladder[0];
  const ackDeadlineMinutes = validatePositiveInteger(
    input.ackDeadlineMinutes ?? 15,
    "ackDeadlineMinutes",
  );
  const deadlineAt = addMinutes(requestedAt, ackDeadlineMinutes);
  const operator = input.operator ?? createSreOperator();
  const obligationId = `obligation-${slug(incident.id)}-ack-1`;
  const handoffPackage = createHandoffPackage({ incident, input });
  const obligation = createObligationEvent("policy.ObligationCreated", {
    id: obligationId,
    rootObligationId: obligationId,
    incident,
    receiver,
    requestedAt,
    deadlineAt,
    handoffPackage,
    ladder,
    ackDeadlineMinutes,
    reason: input.requiresHuman
      ? "requiresHuman signal entered A2H directly"
      : `${incident.severity} incident requires on-call acknowledgement`,
    escalationLevel: 0,
  });
  const notification = createNotificationRequested({
    id: `notify-${slug(incident.id)}-primary`,
    obligation,
    incident,
    receiver,
    requestedAt,
    handoffPackage,
  });
  const handoff = handoffRequested({
    id: `handoff-${slug(incident.id)}-primary`,
    streamId: "crew:sre",
    seq: 1,
    ts: requestedAt,
    principal: operator.principal,
    correlationId: incident.correlationId,
    causationId: obligation.id,
    target: { kind: "human", name: receiver.name },
    reason: obligation.data.reason,
  });

  return deepFreeze({
    status: "waiting-for-ack",
    incident,
    obligation,
    notification,
    handoff,
    events: [obligation, notification, handoff],
  });
}

export function advanceOnCallEscalation(input = {}) {
  const events = requiredArray(input.events, "events");
  const now = validateIso(input.now ?? new Date(0).toISOString(), "now");
  const replay = replayOnCallEscalation(events);
  if (replay.status === "satisfied") {
    return deepFreeze({ status: "satisfied", events: [] });
  }

  const current = latestObligationEvent(events);
  if (!current) {
    throw new Error("events must include an on-call obligation");
  }
  if (Date.parse(now) <= Date.parse(current.data.deadlineAt)) {
    return deepFreeze({ status: "waiting-for-ack", events: [] });
  }

  const incident = {
    id: current.data.incidentId,
    severity: current.data.severity,
    correlationId: current.data.correlationId,
  };
  const ladder = normalizeLadder(current.data.ladder ?? DEFAULT_ESCALATION_LADDER);
  const nextLevel = Math.min(current.data.escalationLevel + 1, ladder.length - 1);
  const receiver = ladder[nextLevel];
  const rootObligationId = current.data.rootObligationId ?? current.id;
  const handoffPackage = current.data.handoffPackage;
  const obligation = createObligationEvent("policy.ObligationEscalated", {
    id: `${rootObligationId}-escalated-${nextLevel}`,
    rootObligationId,
    incident,
    receiver,
    requestedAt: now,
    deadlineAt: addMinutes(now, current.data.ackDeadlineMinutes ?? 15),
    handoffPackage,
    ladder,
    ackDeadlineMinutes: current.data.ackDeadlineMinutes ?? 15,
    reason: `ack deadline missed for ${current.data.receiver.name}`,
    escalationLevel: nextLevel,
    status: "escalated",
  });
  const notification = createNotificationRequested({
    id: `notify-${slug(incident.id)}-escalation-${nextLevel}`,
    obligation,
    incident,
    receiver,
    requestedAt: now,
    handoffPackage,
  });
  const priorHandoff = latestEventOfType(events, "crew.HandoffRequested");
  const operator = input.operator ?? createSreOperator();
  const handoff = handoffRequested({
    id: `handoff-${slug(incident.id)}-escalation-${nextLevel}`,
    streamId: "crew:sre",
    seq: priorHandoff ? priorHandoff.seq + 1 : 1,
    ts: now,
    principal: operator.principal,
    correlationId: incident.correlationId,
    causationId: priorHandoff?.id ?? obligation.id,
    target: { kind: "human", name: receiver.name },
    reason: obligation.data.reason,
  });
  const slaBreach = makeIncidentEvent(INCIDENT_EVENT_TYPES.slaBreached, {
    id: `sla-${slug(incident.id)}-ack-${nextLevel}`,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    causationId: obligation.id,
    occurredAt: now,
    payload: {
      objective: ON_CALL_ACK_OBLIGATION_KIND,
      obligationId: obligation.id,
      receiver: receiver.name,
      escalationLevel: nextLevel,
    },
  });

  return deepFreeze({
    status: "escalated",
    obligation,
    notification,
    handoff,
    slaBreach,
    events: [obligation, notification, handoff, slaBreach],
  });
}

export function recordHumanDecision(input = {}) {
  const events = requiredArray(input.events, "events");
  const decidedAt = validateIso(input.decidedAt ?? new Date(0).toISOString(), "decidedAt");
  const decidedBy = requiredString(input.decidedBy, "decidedBy");
  const decision = validateMember(input.decision, HUMAN_DECISIONS, "decision");
  const replay = replayOnCallEscalation(events);
  if (replay.status === "satisfied") {
    throw new Error("on-call obligation is already satisfied");
  }

  const current = latestObligationEvent(events);
  if (!current) {
    throw new Error("events must include an on-call obligation");
  }
  const incident = {
    id: current.data.incidentId,
    severity: current.data.severity,
    correlationId: current.data.correlationId,
  };
  const obligation = createObligationEvent("policy.ObligationSatisfied", {
    id: `${current.data.rootObligationId ?? current.id}-satisfied`,
    rootObligationId: current.data.rootObligationId ?? current.id,
    incident,
    receiver: current.data.receiver,
    requestedAt: current.data.requestedAt,
    deadlineAt: current.data.deadlineAt,
    handoffPackage: current.data.handoffPackage,
    ladder: current.data.ladder,
    ackDeadlineMinutes: current.data.ackDeadlineMinutes,
    reason: `human selected ${decision}`,
    escalationLevel: current.data.escalationLevel,
    status: "satisfied",
    humanDecision: {
      decision,
      decidedAt,
      decidedBy,
    },
  });

  return deepFreeze({
    status: "satisfied",
    obligation,
    events: [obligation],
  });
}

export function replayOnCallEscalation(eventsInput) {
  const events = requiredArray(eventsInput, "events");
  const obligations = events.filter((event) => event.type?.startsWith("policy.Obligation"));
  const notifications = events.filter((event) => event.type === "notification.Requested");
  const handoffs = events.filter((event) => event.type === "crew.HandoffRequested");
  const slaBreaches = events.filter((event) => event.type === INCIDENT_EVENT_TYPES.slaBreached);
  const latestObligation = obligations.at(-1);
  const satisfied = obligations.find((event) => event.type === "policy.ObligationSatisfied");
  const escalated = [...obligations].reverse().find((event) => event.type === "policy.ObligationEscalated");

  return deepFreeze({
    status: satisfied ? "satisfied" : escalated ? "escalated" : "waiting-for-ack",
    activeReceiver: latestObligation?.data.receiver,
    notificationIds: notifications.map((event) => event.id),
    handoffIds: handoffs.map((event) => event.id),
    slaBreaches,
    humanDecision: satisfied?.data.humanDecision,
  });
}

function createObligationEvent(type, input) {
  return {
    id: input.id,
    type,
    schemaVersion: ON_CALL_ESCALATION_SCHEMA_VERSION,
    streamId: `policy-obligation:${input.incident.id}`,
    data: {
      kind: ON_CALL_ACK_OBLIGATION_KIND,
      status: type === "policy.ObligationCreated" ? "open" : input.status,
      incidentId: input.incident.id,
      correlationId: input.incident.correlationId,
      severity: input.incident.severity,
      rootObligationId: input.rootObligationId,
      receiver: input.receiver,
      requestedAt: input.requestedAt,
      deadlineAt: input.deadlineAt,
      ackDeadlineMinutes: input.ackDeadlineMinutes,
      ladder: input.ladder,
      escalationLevel: input.escalationLevel,
      reason: input.reason,
      handoffPackage: input.handoffPackage,
      humanDecision: input.humanDecision,
    },
  };
}

function createNotificationRequested({ id, obligation, incident, receiver, requestedAt, handoffPackage }) {
  return {
    id,
    type: "notification.Requested",
    schemaVersion: ON_CALL_ESCALATION_SCHEMA_VERSION,
    streamId: `notification:${obligation.id}`,
    data: {
      port: NOTIFY_PORT,
      channel: "page",
      receiver,
      template: "incident-a2h-handoff",
      idempotencyKey: obligation.id,
      incidentId: incident.id,
      correlationId: incident.correlationId,
      requestedAt,
      handoffPackage,
    },
  };
}

function latestObligationEvent(events) {
  return [...events]
    .reverse()
    .find((event) => event.type === "policy.ObligationCreated" || event.type === "policy.ObligationEscalated");
}

function latestEventOfType(events, type) {
  return [...events].reverse().find((event) => event.type === type);
}

function createHandoffPackage({ incident, input }) {
  return deepFreeze({
    incidentId: incident.id,
    severity: incident.severity,
    failingCheck: input.failingCheck ?? incident.causedBy[0]?.type ?? "unknown",
    goldenDiff: input.goldenDiff ?? null,
    proposedFixes: input.proposedFixes ?? [],
    blastRadius: input.blastRadius ?? {
      environment: "prod",
      maxResources: 1,
      reversible: false,
    },
    decisionRequired: "apply-fix | re-bless | abort",
  });
}

function normalizeLadder(input) {
  const ladder = requiredArray(input, "ladder").map((receiver, index) => {
    if (!receiver || !isJsonObject(receiver) || Array.isArray(receiver)) {
      throw new Error(`ladder[${index}] must be an object`);
    }
    return deepFreeze({
      kind: receiver.kind ?? "human",
      name: requiredString(receiver.name, `ladder[${index}].name`),
      provider: requiredString(receiver.provider, `ladder[${index}].provider`),
    });
  });
  if (ladder.length === 0) {
    throw new Error("ladder must contain at least one receiver");
  }
  return Object.freeze(ladder);
}

function addMinutes(iso, minutes) {
  return new Date(Date.parse(iso) + minutes * 60 * 1000).toISOString();
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

function validatePositiveInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive safe integer`);
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

function validateMember(value, allowed, fieldName) {
  if (!allowed.has(value)) {
    throw new Error(`invalid ${fieldName}: ${String(value)}`);
  }
  return value;
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
