import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  foldIncidentStream,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import { foldCrewStream } from "../../crew-event-contract/src/crew-event-contract.js";
import { createProjectionReadStore } from "../../sre-diagnose-projection-contract/src/sre-diagnose-projection.js";
import {
  decideSreRemediation,
  replaySreDecision,
} from "../src/sre-decision-tree.js";

describe("SRE decision tree contract", () => {
  it("routes a low-risk provider-degraded signal to auto-fix with replayable evidence", () => {
    const result = decideSreRemediation({
      incidentEvents: baseIncidentEvents(),
      projections: healthyProjectionStore(),
      runbook: baseRunbook(),
      signal: {
        kind: "provider-region-health",
        region: "us-east-1",
        providerDegraded: true,
        environment: "staging",
        estimatedImpact: "low",
        conformanceState: "green",
      },
      decidedAt: "2026-06-26T08:00:00.000Z",
    });

    assert.equal(result.branch, "auto-fix");
    assert.equal(result.policyDecision.data.effect, "allow");
    assert.equal(result.crewActionProposed.type, "crew.ActionProposed");
    assert.equal(result.incidentRemediationProposed.type, "incident.RemediationProposed");
    assert.equal(result.incidentRemediationProposed.payload.action.kind, "failover");
    assert.equal(result.incidentRemediationProposed.payload.decisionBranch, "auto-fix");

    assert.equal(replaySreDecision(result.events).branch, "auto-fix");
    assert.equal(replaySreDecision(result.events).policyDecisionId, result.policyDecision.id);
    assert.equal(foldCrewStream(result.events.crew).actions.length, 0);
    assert.equal(
      foldIncidentStream(result.events.incident).status,
      "remediation-proposed",
    );
  });

  it("routes a production compat.GateFailed signal to propose, not auto-fix", () => {
    const result = decideSreRemediation({
      incidentEvents: baseIncidentEvents(),
      projections: healthyProjectionStore(),
      runbook: baseRunbook(),
      signal: {
        eventType: "compat.GateFailed",
        kind: "contract-skew",
        environment: "prod",
        estimatedImpact: "low",
        conformanceState: "green",
      },
      decidedAt: "2026-06-26T08:01:00.000Z",
    });

    assert.equal(result.branch, "propose");
    assert.equal(result.policyDecision.data.effect, "require-approval");
    assert.equal(result.incidentRemediationProposed.payload.action.kind, "propose");
    assert.equal(result.reason, "production-requires-approval");
  });

  it("routes an unclassifiable SEV1 to A2H escalation", () => {
    const result = decideSreRemediation({
      incidentEvents: baseIncidentEvents("SEV1"),
      projections: healthyProjectionStore(),
      runbook: baseRunbook(),
      signal: {
        kind: "unknown-catastrophic-signal",
        severity: "SEV1",
        environment: "staging",
        estimatedImpact: "low",
        conformanceState: "green",
      },
      decidedAt: "2026-06-26T08:02:00.000Z",
    });

    assert.equal(result.branch, "escalate");
    assert.equal(result.handoffRequested.type, "crew.HandoffRequested");
    assert.match(result.handoffRequested.data.reason, /unclassifiable/);
    assert.equal(result.incidentRemediationProposed.payload.action.kind, "escalate");
    assert.equal(replaySreDecision(result.events).branch, "escalate");
  });

  it("short-circuits requiresHuman signals into A2H escalation", () => {
    const result = decideSreRemediation({
      incidentEvents: baseIncidentEvents(),
      projections: healthyProjectionStore(),
      runbook: baseRunbook(),
      signal: {
        kind: "saturation",
        utilization: 0.94,
        environment: "staging",
        estimatedImpact: "low",
        conformanceState: "green",
        requiresHuman: true,
      },
      decidedAt: "2026-06-26T08:02:30.000Z",
    });

    assert.equal(result.branch, "escalate");
    assert.equal(result.policyDecision.data.effect, "require-approval");
    assert.equal(result.handoffRequested.type, "crew.HandoffRequested");
    assert.equal(result.incidentRemediationProposed.payload.action.kind, "escalate");
  });

  it("keeps a low-risk production signal out of auto-fix", () => {
    const result = decideSreRemediation({
      incidentEvents: baseIncidentEvents(),
      projections: healthyProjectionStore(),
      runbook: baseRunbook(),
      signal: {
        kind: "saturation",
        utilization: 0.92,
        environment: "prod",
        estimatedImpact: "low",
        conformanceState: "green",
      },
      decidedAt: "2026-06-26T08:03:00.000Z",
    });

    assert.equal(result.branch, "propose");
    assert.equal(result.reason, "production-requires-approval");
  });

  it("does not auto-fix when conformance is not green", () => {
    const result = decideSreRemediation({
      incidentEvents: baseIncidentEvents(),
      projections: healthyProjectionStore(),
      runbook: baseRunbook(),
      signal: {
        kind: "saturation",
        utilization: 0.92,
        environment: "staging",
        estimatedImpact: "low",
        conformanceState: "failing",
      },
      decidedAt: "2026-06-26T08:04:00.000Z",
    });

    assert.equal(result.branch, "propose");
    assert.equal(result.reason, "conformance-not-green");
    assert.equal(result.policyDecision.data.effect, "require-approval");
  });
});

function baseIncidentEvents(severity = "SEV2") {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: "slo-burn-api",
    occurredAt: "2026-06-26T07:55:00.000Z",
    payload: {
      severity,
      impact: "checkout api availability burning",
      causedBy: [{ id: "slo-burn-api", type: "slo.BudgetBurned", correlationId: "corr-api-burn" }],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-api",
    incidentId: "incident-api-burn",
    correlationId: "corr-api-burn",
    causationId: opened.id,
    occurredAt: "2026-06-26T07:56:00.000Z",
    payload: { owner: "operator:sre" },
  });
  return [opened, triaged];
}

function healthyProjectionStore() {
  return createProjectionReadStore({
    "slo_status api.availability": {
      atSeq: 51,
      stale: false,
      value: { rootCauseHint: "provider degradation" },
    },
    "tail_logs api": {
      atSeq: 51,
      stale: false,
      value: { topError: "HTTP 503 from provider edge" },
    },
  });
}

function baseRunbook() {
  return {
    id: "runbook-api-burn",
    diagnose: ["slo_status api.availability", "tail_logs api"],
  };
}
