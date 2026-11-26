import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  deriveIncidentOpenEvents,
  foldIncidentStream,
  makeIncidentEvent,
} from "../src/incident-aggregate.js";

describe("incident aggregate contract", () => {
  it("rejects illegal lifecycle transitions", () => {
    const opened = makeIncidentEvent("incident.Opened", {
      id: "evt-open",
      incidentId: "inc-api-5xx",
      correlationId: "corr-api-5xx",
      payload: {
        severity: "sev2",
        impact: "api error rate above SLO",
        causedBy: [signalRef("alert-1", "alert.Fired", "corr-api-5xx")],
      },
    });
    const applied = makeIncidentEvent("incident.RemediationApplied", {
      id: "evt-applied",
      incidentId: "inc-api-5xx",
      correlationId: "corr-api-5xx",
      causationId: "evt-open",
      payload: { actionId: "action-failover" },
    });

    assert.throws(
      () => foldIncidentStream([opened, applied]),
      /illegal incident transition: opened -> remediation-applied/,
    );
  });

  it("correlates two alert signals with the same correlationId into one Incident", () => {
    const result = deriveIncidentOpenEvents([
      signal("alert-1", "alert.Fired", "corr-provider-degraded"),
      signal("alert-2", "alert.Fired", "corr-provider-degraded"),
    ]);

    assert.equal(result.opened.length, 1);
    assert.equal(result.opened[0].type, INCIDENT_EVENT_TYPES.opened);
    assert.equal(result.opened[0].correlationId, "corr-provider-degraded");
    assert.deepEqual(
      result.opened[0].payload.causedBy.map((cause) => cause.id),
      ["alert-1", "alert-2"],
    );

    const incident = foldIncidentStream(result.opened);
    assert.equal(incident.id, "incident-corr-provider-degraded");
    assert.equal(incident.status, "opened");
    assert.equal(incident.causedBy.length, 2);
  });

  it("rebuilds the timeline exactly from a from-zero replay", () => {
    const events = [
      makeIncidentEvent("incident.Opened", {
        id: "evt-open",
        incidentId: "inc-db-drift",
        correlationId: "corr-db-drift",
        occurredAt: "2026-06-25T00:00:00.000Z",
        payload: {
          severity: "sev3",
          impact: "database drift detected",
          causedBy: [signalRef("drift-1", "resource.DriftDetected", "corr-db-drift")],
        },
      }),
      makeIncidentEvent("incident.Triaged", {
        id: "evt-triaged",
        incidentId: "inc-db-drift",
        correlationId: "corr-db-drift",
        causationId: "evt-open",
        occurredAt: "2026-06-25T00:01:00.000Z",
        payload: { owner: "crew:sre" },
      }),
      makeIncidentEvent("incident.RootCauseIdentified", {
        id: "evt-root-cause",
        incidentId: "inc-db-drift",
        correlationId: "corr-db-drift",
        causationId: "evt-triaged",
        occurredAt: "2026-06-25T00:03:00.000Z",
        payload: { rootCause: "out-of-band schema change" },
      }),
      makeIncidentEvent("incident.RemediationProposed", {
        id: "evt-proposed",
        incidentId: "inc-db-drift",
        correlationId: "corr-db-drift",
        causationId: "evt-root-cause",
        occurredAt: "2026-06-25T00:05:00.000Z",
        payload: { actionId: "action-resync", policyDecisionId: "policy-1" },
      }),
      makeIncidentEvent("incident.RemediationApplied", {
        id: "evt-applied",
        incidentId: "inc-db-drift",
        correlationId: "corr-db-drift",
        causationId: "evt-proposed",
        occurredAt: "2026-06-25T00:08:00.000Z",
        payload: { actionId: "action-resync" },
      }),
      makeIncidentEvent("incident.Resolved", {
        id: "evt-resolved",
        incidentId: "inc-db-drift",
        correlationId: "corr-db-drift",
        causationId: "evt-applied",
        occurredAt: "2026-06-25T00:10:00.000Z",
        payload: { resolution: "projection resynced from authoritative log" },
      }),
    ];

    assert.deepEqual(foldIncidentStream(events), foldIncidentStream([...events]));
    assert.deepEqual(
      foldIncidentStream(events).timeline.map((entry) => entry.type),
      events.map((event) => event.type),
    );
  });

  it("allows a failed remediation to resolve through the documented lifecycle", () => {
    const events = [
      makeIncidentEvent("incident.Opened", {
        id: "evt-open",
        incidentId: "inc-remediation-failed",
        correlationId: "corr-remediation-failed",
        payload: {
          severity: "sev2",
          impact: "rollback action failed",
          causedBy: [signalRef("alert-1", "alert.Fired", "corr-remediation-failed")],
        },
      }),
      makeIncidentEvent("incident.Triaged", {
        id: "evt-triaged",
        incidentId: "inc-remediation-failed",
        correlationId: "corr-remediation-failed",
        causationId: "evt-open",
        payload: { owner: "crew:sre" },
      }),
      makeIncidentEvent("incident.RootCauseIdentified", {
        id: "evt-root-cause",
        incidentId: "inc-remediation-failed",
        correlationId: "corr-remediation-failed",
        causationId: "evt-triaged",
        payload: { rootCause: "compensation target unavailable" },
      }),
      makeIncidentEvent("incident.RemediationProposed", {
        id: "evt-proposed",
        incidentId: "inc-remediation-failed",
        correlationId: "corr-remediation-failed",
        causationId: "evt-root-cause",
        payload: { actionId: "action-compensate", policyDecisionId: "policy-2" },
      }),
      makeIncidentEvent("incident.RemediationFailed", {
        id: "evt-failed",
        incidentId: "inc-remediation-failed",
        correlationId: "corr-remediation-failed",
        causationId: "evt-proposed",
        payload: { actionId: "action-compensate" },
      }),
      makeIncidentEvent("incident.Resolved", {
        id: "evt-resolved",
        incidentId: "inc-remediation-failed",
        correlationId: "corr-remediation-failed",
        causationId: "evt-failed",
        payload: { resolution: "escalated and manually stabilized" },
      }),
    ];

    assert.equal(foldIncidentStream(events).status, "resolved");
  });

  it("does not reopen silently when a duplicate signal arrives after resolution", () => {
    const opened = deriveIncidentOpenEvents([
      signal("alert-1", "alert.Fired", "corr-resolved"),
    ]).opened[0];
    const resolved = foldIncidentStream([
      opened,
      makeIncidentEvent("incident.Triaged", {
        id: "evt-triaged",
        incidentId: opened.payload.incidentId,
        correlationId: opened.correlationId,
        causationId: opened.id,
        payload: { owner: "crew:sre" },
      }),
      makeIncidentEvent("incident.RootCauseIdentified", {
        id: "evt-root-cause",
        incidentId: opened.payload.incidentId,
        correlationId: opened.correlationId,
        causationId: "evt-triaged",
        payload: { rootCause: "provider alert cleared after failover" },
      }),
      makeIncidentEvent("incident.RemediationProposed", {
        id: "evt-proposed",
        incidentId: opened.payload.incidentId,
        correlationId: opened.correlationId,
        causationId: "evt-root-cause",
        payload: { actionId: "action-failover", policyDecisionId: "policy-1" },
      }),
      makeIncidentEvent("incident.RemediationApplied", {
        id: "evt-applied",
        incidentId: opened.payload.incidentId,
        correlationId: opened.correlationId,
        causationId: "evt-proposed",
        payload: { actionId: "action-failover" },
      }),
      makeIncidentEvent("incident.Resolved", {
        id: "evt-resolved",
        incidentId: opened.payload.incidentId,
        correlationId: opened.correlationId,
        causationId: "evt-applied",
        payload: { resolution: "alert cleared" },
      }),
    ]);

    const result = deriveIncidentOpenEvents(
      [signal("alert-duplicate", "alert.Fired", "corr-resolved")],
      [resolved],
    );

    assert.equal(result.opened.length, 0);
    assert.equal(result.duplicates.length, 1);
    assert.equal(result.duplicates[0].existingIncidentId, resolved.id);
    assert.equal(resolved.status, "resolved");
  });

  it("prevents an ownerless incident from advancing past Triaged", () => {
    const opened = makeIncidentEvent("incident.Opened", {
      id: "evt-open",
      incidentId: "inc-ownerless",
      correlationId: "corr-ownerless",
      payload: {
        severity: "sev2",
        impact: "unknown service outage",
        causedBy: [signalRef("alert-1", "alert.Fired", "corr-ownerless")],
      },
    });
    const ownerlessTriaged = makeIncidentEvent("incident.Triaged", {
      id: "evt-triaged",
      incidentId: "inc-ownerless",
      correlationId: "corr-ownerless",
      causationId: "evt-open",
      payload: {},
    });
    const rootCause = makeIncidentEvent("incident.RootCauseIdentified", {
      id: "evt-root-cause",
      incidentId: "inc-ownerless",
      correlationId: "corr-ownerless",
      causationId: "evt-triaged",
      payload: { rootCause: "no owner assigned" },
    });

    assert.throws(
      () => foldIncidentStream([opened, ownerlessTriaged, rootCause]),
      /incident cannot advance past triaged without an owner/,
    );
  });
});

function signal(id, type, correlationId) {
  return {
    id,
    type,
    correlationId,
    occurredAt: "2026-06-25T00:00:00.000Z",
    payload: { severity: "sev2", impact: "synthetic signal" },
  };
}

function signalRef(id, type, correlationId) {
  return { id, type, correlationId };
}
