import { createHash } from "node:crypto";

import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";

export const SRE_PROCESS_SLO_SCHEMA_VERSION = "hobo.sre-process-slo/v1";

export function declareSreProcessSlos(input = {}) {
  const mttdMinutes = positiveNumber(input.mttdMinutes ?? 5, "mttdMinutes");
  const mttrMinutes = positiveNumber(input.mttrMinutes ?? 30, "mttrMinutes");
  const budgetMinutes = positiveNumber(input.budgetMinutes ?? 120, "budgetMinutes");
  const calendar = nonEmptyString(input.calendar ?? "30d", "calendar");

  return deepFreeze([
    openSlo({
      name: "sre.mttd",
      description: "Signal-to-SRE-dispatch duration.",
      indicator: {
        kind: "duration",
        from: "alert.Fired",
        to: "crew.AgentDispatched",
      },
      targetMinutes: mttdMinutes,
      budgetMinutes,
      calendar,
    }),
    openSlo({
      name: "sre.mttr",
      description: "Incident-open-to-incident-resolved duration.",
      indicator: {
        kind: "duration",
        from: INCIDENT_EVENT_TYPES.opened,
        to: INCIDENT_EVENT_TYPES.resolved,
      },
      targetMinutes: mttrMinutes,
      budgetMinutes,
      calendar,
    }),
  ]);
}

export function evaluateSreProcessSlos(input = {}) {
  const slos = input.slos ?? declareSreProcessSlos();
  const signalEvents = array(input.signalEvents ?? [], "signalEvents");
  const crewEvents = array(input.crewEvents ?? [], "crewEvents");
  const incidentEventsInput = array(input.incidentEvents, "incidentEvents");
  const opened = firstEvent(incidentEventsInput, INCIDENT_EVENT_TYPES.opened);
  const resolved = firstEvent(incidentEventsInput, INCIDENT_EVENT_TYPES.resolved);
  const measurements = [];

  const mttdSlo = findSlo(slos, "sre.mttd");
  const firstSignal = firstEvent(signalEvents, "alert.Fired");
  const firstDispatch = firstEvent(crewEvents, "crew.AgentDispatched");
  if (firstSignal && firstDispatch) {
    measurements.push(
      measure({
        objective: "sre.mttd",
        startEvent: firstSignal,
        startAt: eventTime(firstSignal),
        endEvent: firstDispatch,
        endAt: eventTime(firstDispatch),
        slo: mttdSlo,
        incidentId: opened?.payload.incidentId,
      }),
    );
  }

  const mttrSlo = findSlo(slos, "sre.mttr");
  if (opened && resolved) {
    measurements.push(
      measure({
        objective: "sre.mttr",
        startEvent: opened,
        startAt: eventTime(opened),
        endEvent: resolved,
        endAt: eventTime(resolved),
        slo: mttrSlo,
        incidentId: opened.payload.incidentId,
      }),
    );
  }

  const incidentEvents = measurements
    .filter((measurement) => measurement.status === "breached" && opened)
    .map((measurement) =>
      makeIncidentEvent(INCIDENT_EVENT_TYPES.slaBreached, {
        id: `sla-${slug(measurement.incidentId)}-${slug(measurement.objective)}`,
        incidentId: measurement.incidentId,
        correlationId: opened.correlationId,
        causationId: measurement.endEventId,
        occurredAt: measurement.endAt,
        payload: {
          objective: measurement.objective,
          actualMinutes: measurement.actualMinutes,
          targetMinutes: measurement.targetMinutes,
          consumedMinutes: measurement.consumedMinutes,
          remainingBudgetMinutes: measurement.remainingBudgetMinutes,
        },
      }),
    );
  const budgetBurns = measurements
    .filter((measurement) => measurement.status === "breached")
    .map((measurement) => ({
      objective: measurement.objective,
      consumedMinutes: measurement.consumedMinutes,
      remainingMinutes: measurement.remainingBudgetMinutes,
      incidentId: measurement.incidentId,
    }));
  const mttrBurn = budgetBurns.find((burn) => burn.objective === "sre.mttr");
  const mttrBreach = incidentEvents.find((event) => event.payload.objective === "sre.mttr");

  return deepFreeze({
    schemaVersion: SRE_PROCESS_SLO_SCHEMA_VERSION,
    measurements: measurements.map(stripInternalMeasurement),
    budgetBurns,
    incidentEvents,
    canDeploy: mttrBurn
      ? freezeRiskyDeploys({
          mttrBurn,
          mttrBreach,
          measurement: measurements.find((m) => m.objective === "sre.mttr"),
        })
      : allowDeploy(),
  });
}

export function generatePostmortemFromReplay(eventsInput, _options = {}) {
  const events = array(eventsInput, "events");
  const opened = requiredEvent(events, INCIDENT_EVENT_TYPES.opened);
  const resolved = requiredEvent(events, INCIDENT_EVENT_TYPES.resolved);
  const rootCause = firstEvent(events, INCIDENT_EVENT_TYPES.rootCauseIdentified);
  const failedRemediations = events.filter(
    (event) => event.type === INCIDENT_EVENT_TYPES.remediationFailed,
  );
  const regressionTests = failedRemediations.map((event) =>
    regressionTestFor({ incidentId: opened.payload.incidentId, event }),
  );
  const candidateUpdates = failedRemediations.flatMap((event) =>
    candidateUpdatesFor({ incidentId: opened.payload.incidentId, event }),
  );
  const timeline = events.map(timelineEntry);
  const mttrMinutes = minutesBetween(eventTime(opened), eventTime(resolved));
  const markdown = renderPostmortem({
    incidentId: opened.payload.incidentId,
    severity: opened.payload.severity,
    impact: opened.payload.impact,
    rootCause: rootCause?.payload.rootCause ?? "unknown",
    resolution: resolved.payload.resolution,
    mttrMinutes,
    timeline,
    regressionTests,
    candidateUpdates,
  });
  const contentHash = sha256(markdown);
  const event = makeIncidentEvent(INCIDENT_EVENT_TYPES.postmortemFiled, {
    id: `incident-postmortem-filed-${slug(opened.payload.incidentId)}`,
    incidentId: opened.payload.incidentId,
    correlationId: opened.correlationId,
    causationId: resolved.id,
    occurredAt: resolved.occurredAt,
    payload: {
      postmortemRef: `postmortem://${opened.payload.incidentId}/${contentHash}`,
      contentHash,
      replayEventCount: events.length,
      regressionTests: regressionTests.map((test) => test.id),
      candidateUpdates: candidateUpdates.map((update) => update.id),
    },
  });

  return deepFreeze({
    schemaVersion: SRE_PROCESS_SLO_SCHEMA_VERSION,
    incidentId: opened.payload.incidentId,
    markdown,
    contentHash,
    event,
    timeline,
    regressionTests,
    candidateUpdates,
  });
}

function openSlo({ name, description, indicator, targetMinutes, budgetMinutes, calendar }) {
  return {
    apiVersion: "openslo/v1",
    kind: "SLO",
    metadata: {
      name,
      labels: {
        subsystem: "operators-sre",
      },
    },
    spec: {
      description,
      indicator,
      objective: {
        targetMinutes,
        op: "<=",
      },
      budget: {
        minutes: budgetMinutes,
        calendar,
      },
    },
  };
}

function measure({ objective, startEvent, startAt, endEvent, endAt, slo, incidentId }) {
  const targetMinutes = slo.spec.objective.targetMinutes;
  const budgetMinutes = slo.spec.budget.minutes;
  const actualMinutes = minutesBetween(startAt, endAt);
  const consumedMinutes = Math.max(0, actualMinutes - targetMinutes);

  return {
    objective,
    startEventId: startEvent.id,
    endEventId: endEvent.id,
    startAt,
    endAt,
    actualMinutes,
    targetMinutes,
    status: consumedMinutes > 0 ? "breached" : "met",
    consumedMinutes,
    remainingBudgetMinutes: Math.max(0, budgetMinutes - consumedMinutes),
    incidentId,
  };
}

function stripInternalMeasurement(measurement) {
  const result = {
    objective: measurement.objective,
    startEventId: measurement.startEventId,
    endEventId: measurement.endEventId,
    startAt: measurement.startAt,
    endAt: measurement.endAt,
    actualMinutes: measurement.actualMinutes,
    targetMinutes: measurement.targetMinutes,
    status: measurement.status,
  };
  if (measurement.status === "breached") {
    result.consumedMinutes = measurement.consumedMinutes;
    result.remainingBudgetMinutes = measurement.remainingBudgetMinutes;
  }
  return result;
}

function freezeRiskyDeploys({ mttrBurn, mttrBreach, measurement }) {
  return {
    allowed: false,
    decision: "freeze-risky-deploys",
    dimension: "sre.mttr",
    reasonCode: "sre.mttr-budget-burn-freeze-risky-deploys",
    audit: {
      incidentId: mttrBurn.incidentId,
      breachEventId: mttrBreach.id,
      objective: "sre.mttr",
      reason:
        `MTTR exceeded by ${mttrBurn.consumedMinutes} minutes; ` +
        "freeze risky deploys until deeper postmortem is filed.",
      actualMinutes: measurement.actualMinutes,
      targetMinutes: measurement.targetMinutes,
      remainingBudgetMinutes: mttrBurn.remainingMinutes,
    },
  };
}

function allowDeploy() {
  return {
    allowed: true,
    decision: "allow",
    dimension: "sre-process",
    reasonCode: "sre-process-budget-ok",
    audit: {
      reason: "SRE MTTD/MTTR process SLOs have no error-budget burn.",
    },
  };
}

function renderPostmortem(input) {
  const timeline = input.timeline
    .map((entry) => `- ${entry.occurredAt} ${entry.type} (${entry.id})`)
    .join("\n");
  const regressionTests =
    input.regressionTests.length === 0
      ? "- none"
      : input.regressionTests.map((test) => `- ${test.id}: ${test.command}`).join("\n");
  const candidateUpdates =
    input.candidateUpdates.length === 0
      ? "- none"
      : input.candidateUpdates
          .map((update) => `- ${update.id}: ${update.kind} via ${update.promotion}`)
          .join("\n");

  return [
    `# Incident Postmortem: ${input.incidentId}`,
    "",
    `Severity: ${input.severity}`,
    `Impact: ${input.impact}`,
    `Root cause: ${input.rootCause}`,
    `Resolution: ${input.resolution}`,
    `MTTR minutes: ${input.mttrMinutes}`,
    "",
    "## Timeline",
    timeline,
    "",
    "## Regression Tests",
    regressionTests,
    "",
    "## Candidate Updates",
    candidateUpdates,
    "",
  ].join("\n");
}

function regressionTestFor({ incidentId, event }) {
  const actionId = nonEmptyString(
    event.payload.idempotencyKey ?? event.payload.actionId,
    "failed remediation actionId",
  );

  return {
    id: `regression-${slug(incidentId)}-${slug(actionId)}`,
    kind: "incident-replay-regression",
    incidentId,
    sourceEventId: event.id,
    command: `hobo incident replay ${incidentId} --assert failed-remediation:${actionId}`,
  };
}

function candidateUpdatesFor({ incidentId, event }) {
  return ["runbook", "sre-prompt"].map((kind) => ({
    id: `${kind}-candidate-${slug(incidentId)}-${slug(event.id)}`,
    kind,
    promotion: "gated-eval-required",
    incidentId,
    sourceEventId: event.id,
    gate: "generated-artifact-eval",
  }));
}

function timelineEntry(event) {
  return {
    id: event.id,
    type: event.type,
    occurredAt: eventTime(event),
  };
}

function findSlo(slos, name) {
  const slo = slos.find((entry) => entry?.metadata?.name === name);
  if (!slo) {
    throw new Error(`missing SLO declaration: ${name}`);
  }
  return slo;
}

function firstEvent(events, type) {
  return events.find((event) => event.type === type);
}

function requiredEvent(events, type) {
  const event = firstEvent(events, type);
  if (!event) {
    throw new Error(`replay requires ${type}`);
  }
  return event;
}

function eventTime(event) {
  const value = event.occurredAt ?? event.ts ?? event.time;
  if (!isString(value) || Number.isNaN(Date.parse(value))) {
    throw new Error(`${event.id ?? "event"} requires an ISO timestamp`);
  }
  return value;
}

function minutesBetween(startIso, endIso) {
  const minutes = (Date.parse(endIso) - Date.parse(startIso)) / 60_000;
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw new Error("event timestamps must be ordered");
  }
  return Number.isInteger(minutes) ? minutes : Number(minutes.toFixed(3));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function array(value, fieldName) {
  if (!Array.isArray(value)) {
    throw new Error(`${fieldName} must be an array`);
  }
  return value;
}

function positiveNumber(value, fieldName) {
  if (!isNumber(value) || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${fieldName} must be a positive number`);
  }
  return value;
}

function nonEmptyString(value, fieldName) {
  if (!isString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
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
  if (!isObjectRecord(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}

function isObjectRecord(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isNumber(value) {
  return Object.prototype.toString.call(value) === "[object Number]";
}

function isString(value) {
  return Object.prototype.toString.call(value) === "[object String]";
}
