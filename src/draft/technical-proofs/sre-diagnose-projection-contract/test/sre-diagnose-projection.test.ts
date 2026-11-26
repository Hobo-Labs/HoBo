import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  createProjectionReadStore,
  diagnoseIncident,
} from "../src/sre-diagnose-projection.js";

describe("SRE diagnose projection contract", () => {
  it("diagnoses an open Incident from read-only projections and replays to the same root cause", () => {
    const opened = incidentOpened();
    const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
      id: "incident-triaged-api",
      incidentId: "incident-api-burn",
      correlationId: "corr-api-burn",
      causationId: opened.id,
      occurredAt: "2026-06-25T12:01:00.000Z",
      payload: { owner: "operator:sre" },
    });

    const result = diagnoseIncident({
      incidentEvents: [opened, triaged],
      projections: createProjectionReadStore({
        "slo_status api.availability": {
          atSeq: 41,
          stale: false,
          value: { burnRate: 14.4, failingObjective: "availability", rootCauseHint: "api error budget burn" },
        },
        "tail_logs api": {
          atSeq: 41,
          stale: false,
          value: { topError: "HTTP 503 from checkout-api", sampleCount: 37 },
        },
        "get_drift api": {
          atSeq: 41,
          stale: false,
          value: { drifted: false },
        },
      }),
      runbook: {
        id: "runbook-api-burn",
        diagnose: ["slo_status api.availability", "tail_logs api", "get_drift api"],
      },
      diagnosedAt: "2026-06-25T12:02:00.000Z",
    });

    assert.equal(result.rootCauseEvent.type, "incident.RootCauseIdentified");
    assert.equal(result.rootCauseEvent.payload.rootCause, "api error budget burn: HTTP 503 from checkout-api");
    assert.deepEqual(result.rootCauseEvent.payload.projectionReads, [
      { query: "slo_status api.availability", atSeq: 41 },
      { query: "tail_logs api", atSeq: 41 },
      { query: "get_drift api", atSeq: 41 },
    ]);

    const replayed = foldIncidentStream([opened, triaged, result.rootCauseEvent]);

    assert.equal(replayed.rootCause, result.diagnosis.rootCause);
    assert.equal(result.handoffEvents.length, 0);
    assert.equal(result.capabilityDeniedEvents.length, 0);
  });

  it("denies mutation attempts during diagnose and escalates without emitting a root-cause event", () => {
    const opened = incidentOpened();
    const triaged = incidentTriaged(opened);

    const result = diagnoseIncident({
      incidentEvents: [opened, triaged],
      projections: createProjectionReadStore({
        "tail_logs api": {
          atSeq: 42,
          stale: false,
          value: { topError: "HTTP 503 from checkout-api" },
        },
      }),
      runbook: {
        id: "runbook-api-burn",
        diagnose: ["tail_logs api"],
      },
      engine({ tools }) {
        tools.write({
          type: "incident.RemediationProposed",
          payload: { actionId: "restart-api" },
        });
        return { rootCause: "api saturation" };
      },
      diagnosedAt: "2026-06-25T12:02:00.000Z",
    });

    assert.equal(result.rootCauseEvent, undefined);
    assert.deepEqual(result.capabilityDeniedEvents, [
      {
        type: "capability.Denied",
        capability: "incident:write",
        attemptedAction: "incident.RemediationProposed",
        reason: "diagnose step is read-only",
      },
    ]);
    assert.equal(result.handoffEvents.length, 1);
    assert.equal(result.handoffEvents[0].type, "crew.HandoffRequested");
    assert.match(result.handoffEvents[0].data.reason, /diagnose attempted write/);
  });

  it("escalates stale or missing projections as insufficient evidence instead of guessing a fix", () => {
    const opened = incidentOpened();
    const triaged = incidentTriaged(opened);

    const result = diagnoseIncident({
      incidentEvents: [opened, triaged],
      projections: createProjectionReadStore({
        "slo_status api.availability": {
          atSeq: 40,
          stale: true,
          value: { rootCauseHint: "api error budget burn" },
        },
      }),
      runbook: {
        id: "runbook-api-burn",
        diagnose: ["slo_status api.availability", "tail_logs api"],
      },
      diagnosedAt: "2026-06-25T12:02:00.000Z",
    });

    assert.equal(result.rootCauseEvent, undefined);
    assert.equal(result.diagnosis.status, "insufficient-evidence");
    assert.deepEqual(result.diagnosis.missingOrStale, [
      { query: "slo_status api.availability", reason: "stale", atSeq: 40 },
      { query: "tail_logs api", reason: "missing", atSeq: -1 },
    ]);
    assert.equal(result.handoffEvents.length, 1);
    assert.match(result.handoffEvents[0].data.reason, /insufficient evidence/);
    assert.equal(result.capabilityDeniedEvents.length, 0);
  });
});

function incidentOpened() {
  return makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: "slo-burn-api",
    occurredAt: "2026-06-25T12:00:00.000Z",
    payload: {
      severity: "high",
      impact: "checkout api availability burning",
      causedBy: [{ id: "slo-burn-api", type: "slo.BudgetBurned", correlationId: "corr-api-burn" }],
    },
  });
}

function incidentTriaged(opened) {
  return makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: opened.id,
    occurredAt: "2026-06-25T12:01:00.000Z",
    payload: { owner: "operator:sre" },
  });
}
