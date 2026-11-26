import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { handoffRequested } from "../../crew-event-contract/src/crew-event-contract.js";
import { createSreOperator } from "../../sre-operator-skeleton-contract/src/sre-operator-skeleton.js";
import { isJsonString, isJsonObject } from "./json.js";


export function createProjectionReadStore(snapshots = {}) {
  const entries = new Map();

  for (const [query, snapshot] of Object.entries(snapshots)) {
    entries.set(query, normalizeSnapshot(query, snapshot));
  }

  return deepFreeze({
    read(query) {
      assertNonEmptyString(query, "projection query");
      return entries.get(query) ?? missingSnapshot(query);
    },
  });
}

export function diagnoseIncident(input = {}) {
  const incidentEvents = validateIncidentEvents(input.incidentEvents);
  const incident = foldIncidentStream(incidentEvents);
  const projectionReads = readRunbookProjections(input.runbook, input.projections);
  const diagnosedAt = input.diagnosedAt ?? new Date(0).toISOString();
  const operator = input.operator ?? createSreOperator();
  const missingOrStale = insufficientEvidence(projectionReads);

  if (missingOrStale.length > 0) {
    return deepFreeze({
      incident,
      diagnosis: {
        status: "insufficient-evidence",
        missingOrStale,
      },
      rootCauseEvent: undefined,
      handoffEvents: [
        diagnoseHandoff({
          incident,
          operator,
          diagnosedAt,
          reason: `insufficient evidence: ${missingOrStale.map((item) => item.query).join(", ")}`,
          idSuffix: "insufficient-evidence",
        }),
      ],
      capabilityDeniedEvents: [],
    });
  }

  const engineResult = runDiagnosisEngine(input.engine, projectionReads);

  if (engineResult.denied) {
    return deepFreeze({
      incident,
      diagnosis: {
        status: "escalated",
        reason: "diagnose attempted write",
      },
      rootCauseEvent: undefined,
      handoffEvents: [
        diagnoseHandoff({
          incident,
          operator,
          diagnosedAt,
          reason: "diagnose attempted write during read-only phase",
          idSuffix: "write",
        }),
      ],
      capabilityDeniedEvents: [engineResult.denied],
    });
  }

  const diagnosis = engineResult.diagnosis;

  const rootCauseEvent = makeIncidentEvent(INCIDENT_EVENT_TYPES.rootCauseIdentified, {
    id: `incident-root-cause-${slug(incident.id)}`,
    incidentId: incident.id,
    correlationId: incident.correlationId,
    causationId: incident.timeline.at(-1)?.id,
    occurredAt: diagnosedAt,
    payload: {
      rootCause: diagnosis.rootCause,
      diagnosisEngine: "hobo:sre-engine/built-in@0.1.0",
      projectionReads: projectionReads.map((read) => ({ query: read.query, atSeq: read.atSeq })),
    },
  });

  return deepFreeze({
    incident,
    diagnosis,
    rootCauseEvent,
    handoffEvents: [],
    capabilityDeniedEvents: [],
  });
}

function diagnoseHandoff({ incident, operator, diagnosedAt, reason, idSuffix }) {
  return handoffRequested({
    id: `handoff-diagnose-${idSuffix}-${slug(incident.id)}`,
    streamId: "crew:sre",
    seq: 1,
    ts: diagnosedAt,
    principal: operator.principal,
    correlationId: incident.correlationId,
    causationId: incident.timeline.at(-1)?.id,
    target: { kind: "human", name: "on-call" },
    reason,
  });
}

function runDiagnosisEngine(engine, projectionReads) {
  const tools = {
    read(query) {
      return projectionReads.find((read) => read.query === query) ?? missingSnapshot(query);
    },
    write(action = {}) {
      const denied = {
        type: "capability.Denied",
        capability: "incident:write",
        attemptedAction: action.type ?? "unknown",
        reason: "diagnose step is read-only",
      };
      const error = new Error("diagnose attempted write");
      error.capabilityDenied = denied;
      throw error;
    },
  };

  if (!engine) {
    return { diagnosis: buildDiagnosis(projectionReads) };
  }

  try {
    const result = engine({ tools, evidence: projectionReads });
    return {
      diagnosis: {
        rootCause: assertRootCause(result?.rootCause),
        evidence: projectionReads.map((read) => ({ query: read.query, atSeq: read.atSeq })),
      },
    };
  } catch (error) {
    if (error?.capabilityDenied) {
      return { denied: error.capabilityDenied };
    }
    throw error;
  }
}

function validateIncidentEvents(events) {
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error("incidentEvents must be a non-empty array");
  }
  return events;
}

function readRunbookProjections(runbook, projections) {
  if (!runbook || !isJsonObject(runbook) || Array.isArray(runbook)) {
    throw new Error("runbook is required");
  }
  if (!Array.isArray(runbook.diagnose) || runbook.diagnose.length === 0) {
    throw new Error("runbook.diagnose must list projection reads");
  }
  if (!projections || !(projections.read instanceof Function)) {
    throw new Error("read-only projections are required");
  }

  return runbook.diagnose.map((query) => projections.read(query));
}

function buildDiagnosis(reads) {
  const slo = reads.find((read) => read.query.startsWith("slo_status "))?.value ?? {};
  const logs = reads.find((read) => read.query.startsWith("tail_logs "))?.value ?? {};
  const rootCause = [slo.rootCauseHint, logs.topError].filter(Boolean).join(": ");

  return {
    rootCause: rootCause || "insufficient evidence",
    evidence: reads.map((read) => ({ query: read.query, atSeq: read.atSeq })),
  };
}

function insufficientEvidence(reads) {
  return reads
    .filter((read) => read.missing || read.stale)
    .map((read) => ({
      query: read.query,
      reason: read.missing ? "missing" : "stale",
      atSeq: read.atSeq,
    }));
}

function assertRootCause(value) {
  assertNonEmptyString(value, "rootCause");
  return value;
}

function normalizeSnapshot(query, snapshot) {
  if (!snapshot || !isJsonObject(snapshot) || Array.isArray(snapshot)) {
    throw new Error(`projection ${query} must be an object`);
  }
  if (!Number.isSafeInteger(snapshot.atSeq) || snapshot.atSeq < 0) {
    throw new Error(`projection ${query} atSeq must be a non-negative integer`);
  }
  return deepFreeze({
    query,
    atSeq: snapshot.atSeq,
    stale: snapshot.stale === true,
    value: snapshot.value ?? {},
  });
}

function missingSnapshot(query) {
  return deepFreeze({
    query,
    atSeq: -1,
    stale: true,
    missing: true,
    value: {},
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

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }

  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return Object.freeze(value);
}
