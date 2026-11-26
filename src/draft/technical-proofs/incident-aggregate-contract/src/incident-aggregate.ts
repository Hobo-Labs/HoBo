import { isJsonString, isJsonObject } from "./json.js";
export const INCIDENT_EVENT_TYPES = Object.freeze({
  opened: "incident.Opened",
  triaged: "incident.Triaged",
  rootCauseIdentified: "incident.RootCauseIdentified",
  remediationProposed: "incident.RemediationProposed",
  remediationApplied: "incident.RemediationApplied",
  remediationFailed: "incident.RemediationFailed",
  resolved: "incident.Resolved",
  slaBreached: "incident.SLABreached",
  postmortemFiled: "incident.PostmortemFiled",
});

const STATUS_BY_EVENT = Object.freeze({
  [INCIDENT_EVENT_TYPES.opened]: "opened",
  [INCIDENT_EVENT_TYPES.triaged]: "triaged",
  [INCIDENT_EVENT_TYPES.rootCauseIdentified]: "root-cause-identified",
  [INCIDENT_EVENT_TYPES.remediationProposed]: "remediation-proposed",
  [INCIDENT_EVENT_TYPES.remediationApplied]: "remediation-applied",
  [INCIDENT_EVENT_TYPES.remediationFailed]: "remediation-failed",
  [INCIDENT_EVENT_TYPES.resolved]: "resolved",
  [INCIDENT_EVENT_TYPES.postmortemFiled]: "postmortem-filed",
});

const SOURCE_SIGNAL_TYPES = new Set([
  "alert.Fired",
  "slo.BudgetBurned",
  "resource.DriftDetected",
  "compat.GateFailed",
  "spend.CircuitTripped",
  "golden.Failed",
  "golden.Drifted",
]);

const ADVANCE_ALLOWED = Object.freeze({
  opened: new Set(["triaged"]),
  triaged: new Set(["root-cause-identified"]),
  "root-cause-identified": new Set(["remediation-proposed"]),
  "remediation-proposed": new Set(["remediation-applied", "remediation-failed"]),
  "remediation-failed": new Set(["remediation-proposed", "resolved"]),
  "remediation-applied": new Set(["resolved"]),
  resolved: new Set(["postmortem-filed"]),
  "postmortem-filed": new Set(),
});

export function makeIncidentEvent(
  type,
  { id, incidentId, correlationId, causationId, occurredAt, payload = {} },
) {
  assertIncidentEventType(type);
  assertNonEmptyString(id, "event id");
  assertNonEmptyString(incidentId, "incidentId");
  assertNonEmptyString(correlationId, "correlationId");

  return {
    id,
    type,
    correlationId,
    ...(causationId ? { causationId } : undefined),
    occurredAt: occurredAt ?? new Date(0).toISOString(),
    payload: {
      incidentId,
      ...payload,
    },
  };
}

export function deriveIncidentOpenEvents(signals, existingIncidents = []) {
  const grouped = new Map();
  const duplicates = [];
  const existingByCorrelation = new Map();

  for (const incident of existingIncidents) {
    const keys = new Set([
      incident?.correlationId,
      ...(incident?.causedBy ?? []).map((cause) => cause.correlationId),
    ]);
    for (const key of keys) {
      if (key) existingByCorrelation.set(key, incident);
    }
  }

  for (const signal of signals) {
    validateSourceSignal(signal);
    const key = signal.correlationId ?? signal.id;
    const existing = existingByCorrelation.get(key);
    if (existing) {
      duplicates.push({
        signalId: signal.id,
        existingIncidentId: existing.id,
        correlationId: key,
      });
      continue;
    }

    if (!grouped.has(key)) {
      grouped.set(key, []);
    }
    grouped.get(key).push(signal);
  }

  const opened = [...grouped.entries()].map(([correlationId, group]) => {
    const incidentId = `incident-${slug(correlationId)}`;
    const first = group[0];

    return makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
      id: `event-open-${slug(correlationId)}`,
      incidentId,
      correlationId,
      occurredAt: earliestOccurredAt(group),
      payload: {
        severity: first.payload?.severity ?? "unknown",
        impact: first.payload?.impact ?? "unknown impact",
        causedBy: group.map(signalRef),
      },
    });
  });

  return { opened, duplicates };
}

export function foldIncidentStream(events) {
  let state = null;

  for (const event of events) {
    validateIncidentEvent(event);

    if (event.type === INCIDENT_EVENT_TYPES.opened) {
      if (state) {
        throw new Error(`incident stream ${state.id} cannot open twice`);
      }
      state = openIncident(event);
      continue;
    }

    if (!state) {
      throw new Error(`incident stream must start with ${INCIDENT_EVENT_TYPES.opened}`);
    }
    if (event.payload.incidentId !== state.id) {
      throw new Error(`event ${event.id} belongs to ${event.payload.incidentId}, not ${state.id}`);
    }
    if (event.type === INCIDENT_EVENT_TYPES.slaBreached) {
      state = recordSlaBreach(state, event);
      continue;
    }

    const nextStatus = STATUS_BY_EVENT[event.type];
    assertCanAdvance(state, nextStatus);
    state = applyLifecycleEvent(state, event, nextStatus);
  }

  if (!state) {
    throw new Error("incident stream is empty");
  }

  return freezeIncident(state);
}

function openIncident(event) {
  validateOpenedPayload(event.payload);

  return {
    id: event.payload.incidentId,
    streamId: `incident:${event.payload.incidentId}`,
    severity: event.payload.severity,
    impact: event.payload.impact,
    status: "opened",
    correlationId: event.correlationId,
    owner: null,
    rootCause: null,
    resolution: null,
    causedBy: event.payload.causedBy.map((cause) => ({ ...cause })),
    timeline: [timelineEntry(event)],
    slaBreaches: [],
  };
}

function applyLifecycleEvent(state, event, nextStatus) {
  const next = {
    ...state,
    status: nextStatus,
    timeline: [...state.timeline, timelineEntry(event)],
  };

  if (event.type === INCIDENT_EVENT_TYPES.triaged) {
    next.owner = event.payload.owner ?? null;
  }
  if (event.type === INCIDENT_EVENT_TYPES.rootCauseIdentified) {
    assertNonEmptyString(event.payload.rootCause, "rootCause");
    next.rootCause = event.payload.rootCause;
  }
  if (event.type === INCIDENT_EVENT_TYPES.remediationProposed) {
    assertNonEmptyString(event.payload.actionId, "actionId");
    assertNonEmptyString(event.payload.policyDecisionId, "policyDecisionId");
    next.proposedActionId = event.payload.actionId;
    next.policyDecisionId = event.payload.policyDecisionId;
  }
  if (
    event.type === INCIDENT_EVENT_TYPES.remediationApplied ||
    event.type === INCIDENT_EVENT_TYPES.remediationFailed
  ) {
    assertNonEmptyString(event.payload.actionId, "actionId");
    next.remediationActionId = event.payload.actionId;
  }
  if (event.type === INCIDENT_EVENT_TYPES.resolved) {
    assertNonEmptyString(event.payload.resolution, "resolution");
    next.resolution = event.payload.resolution;
  }
  if (event.type === INCIDENT_EVENT_TYPES.postmortemFiled) {
    assertNonEmptyString(event.payload.postmortemRef, "postmortemRef");
    next.postmortemRef = event.payload.postmortemRef;
  }

  return next;
}

function assertCanAdvance(state, nextStatus) {
  if (state.status === "triaged" && !state.owner && nextStatus !== "triaged") {
    throw new Error("incident cannot advance past triaged without an owner");
  }

  const allowed = ADVANCE_ALLOWED[state.status] ?? new Set();
  if (!allowed.has(nextStatus)) {
    throw new Error(`illegal incident transition: ${state.status} -> ${nextStatus}`);
  }
}

function recordSlaBreach(state, event) {
  return {
    ...state,
    timeline: [...state.timeline, timelineEntry(event)],
    slaBreaches: [
      ...state.slaBreaches,
      {
        eventId: event.id,
        occurredAt: event.occurredAt,
        objective: event.payload.objective,
      },
    ],
  };
}

function validateIncidentEvent(event) {
  if (!event || !isJsonObject(event) || Array.isArray(event)) {
    throw new Error("incident event must be an object");
  }
  assertIncidentEventType(event.type);
  assertNonEmptyString(event.id, "event id");
  assertNonEmptyString(event.correlationId, "correlationId");
  assertNonEmptyString(event.payload?.incidentId, "incidentId");
}

function validateOpenedPayload(payload) {
  assertNonEmptyString(payload.severity, "severity");
  assertNonEmptyString(payload.impact, "impact");
  if (!Array.isArray(payload.causedBy) || payload.causedBy.length === 0) {
    throw new Error("incident.Opened requires at least one cause");
  }
}

function validateSourceSignal(signal) {
  if (!signal || !isJsonObject(signal) || Array.isArray(signal)) {
    throw new Error("signal must be an object");
  }
  assertNonEmptyString(signal.id, "signal id");
  assertNonEmptyString(signal.correlationId, "signal correlationId");
  if (!SOURCE_SIGNAL_TYPES.has(signal.type)) {
    throw new Error(`unsupported incident source signal: ${String(signal.type)}`);
  }
}

function assertIncidentEventType(type) {
  if (!Object.values(INCIDENT_EVENT_TYPES).includes(type)) {
    throw new Error(`unknown incident event type: ${String(type)}`);
  }
}

function signalRef(signal) {
  return {
    id: signal.id,
    type: signal.type,
    correlationId: signal.correlationId,
  };
}

function timelineEntry(event) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: event.occurredAt,
    ...(event.causationId ? { causationId: event.causationId } : undefined),
  };
}

function earliestOccurredAt(events) {
  return events
    .map((event) => event.occurredAt)
    .filter(Boolean)
    .sort()[0] ?? new Date(0).toISOString();
}

function freezeIncident(state) {
  return Object.freeze({
    ...state,
    causedBy: Object.freeze(state.causedBy.map((cause) => Object.freeze({ ...cause }))),
    timeline: Object.freeze(state.timeline.map((entry) => Object.freeze({ ...entry }))),
    slaBreaches: Object.freeze(state.slaBreaches.map((entry) => Object.freeze({ ...entry }))),
  });
}

function assertNonEmptyString(value, label) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function slug(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}
