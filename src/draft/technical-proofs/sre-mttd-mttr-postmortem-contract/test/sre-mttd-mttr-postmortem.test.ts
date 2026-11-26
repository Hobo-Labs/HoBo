import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  declareSreProcessSlos,
  evaluateSreProcessSlos,
  generatePostmortemFromReplay,
} from "../src/sre-mttd-mttr-postmortem.js";

describe("SRE MTTD/MTTR SLO and postmortem replay contract", () => {
  it("declares MTTD and MTTR as OpenSLO-compatible SLOs", () => {
    const slos = declareSreProcessSlos({
      mttdMinutes: 5,
      mttrMinutes: 15,
      budgetMinutes: 60,
      calendar: "30d",
    });

    assert.deepEqual(
      slos.map((slo) => slo.metadata.name),
      ["sre.mttd", "sre.mttr"],
    );
    assert.deepEqual(slos[0].spec.indicator, {
      kind: "duration",
      from: "alert.Fired",
      to: "crew.AgentDispatched",
    });
    assert.deepEqual(slos[1].spec.indicator, {
      kind: "duration",
      from: "incident.Opened",
      to: "incident.Resolved",
    });
    assert.equal(slos[1].spec.budget.minutes, 60);
    assert.equal(slos[1].spec.objective.targetMinutes, 15);
  });

  it("burns MTTR budget, emits SLABreached, and freezes risky deploys with an audit reason", () => {
    const result = evaluateSreProcessSlos({
      signalEvents: [alertFired()],
      crewEvents: [agentDispatched()],
      incidentEvents: resolvedIncidentEvents({
        resolvedAt: "2026-06-27T18:26:00.000Z",
      }),
      slos: declareSreProcessSlos({ mttdMinutes: 5, mttrMinutes: 15, budgetMinutes: 60 }),
    });

    assert.deepEqual(
      result.measurements.map((measurement) => [
        measurement.objective,
        measurement.actualMinutes,
        measurement.status,
      ]),
      [
        ["sre.mttd", 2, "met"],
        ["sre.mttr", 26, "breached"],
      ],
    );
    assert.deepEqual(result.budgetBurns, [
      {
        objective: "sre.mttr",
        consumedMinutes: 11,
        remainingMinutes: 49,
        incidentId: "incident-checkout-sev1",
      },
    ]);
    assert.equal(result.incidentEvents.length, 1);
    assert.equal(result.incidentEvents[0].type, INCIDENT_EVENT_TYPES.slaBreached);
    assert.equal(result.incidentEvents[0].payload.objective, "sre.mttr");
    assert.equal(result.incidentEvents[0].payload.actualMinutes, 26);
    assert.equal(result.canDeploy.allowed, false);
    assert.equal(result.canDeploy.dimension, "sre.mttr");
    assert.equal(result.canDeploy.reasonCode, "sre.mttr-budget-burn-freeze-risky-deploys");
    assert.match(result.canDeploy.audit.reason, /MTTR exceeded by 11 minutes/);
    assert.equal(result.canDeploy.audit.breachEventId, result.incidentEvents[0].id);
  });

  it("keeps can-deploy open when SRE process SLOs stay inside budget", () => {
    const result = evaluateSreProcessSlos({
      signalEvents: [alertFired()],
      crewEvents: [agentDispatched()],
      incidentEvents: resolvedIncidentEvents({
        resolvedAt: "2026-06-27T18:11:00.000Z",
      }),
      slos: declareSreProcessSlos({ mttdMinutes: 5, mttrMinutes: 15, budgetMinutes: 60 }),
    });

    assert.deepEqual(result.budgetBurns, []);
    assert.deepEqual(result.incidentEvents, []);
    assert.equal(result.canDeploy.allowed, true);
    assert.equal(result.canDeploy.reasonCode, "sre-process-budget-ok");
  });

  it("generates a byte-stable postmortem and PostmortemFiled fact from replay only", () => {
    const events = resolvedIncidentEvents({
      resolvedAt: "2026-06-27T18:26:00.000Z",
      failedRemediation: true,
    });
    const first = generatePostmortemFromReplay(events, {
      privilegedState: { pagerSecret: "never-print-this" },
    });
    const second = generatePostmortemFromReplay(events, {
      privilegedState: { pagerSecret: "different-secret" },
    });

    assert.equal(first.markdown, second.markdown);
    assert.equal(first.contentHash, second.contentHash);
    assert.ok(!first.markdown.includes("never-print-this"));
    assert.equal(first.event.type, INCIDENT_EVENT_TYPES.postmortemFiled);
    assert.equal(first.event.payload.contentHash, first.contentHash);
    assert.equal(first.event.payload.replayEventCount, events.length);
    assert.deepEqual(
      first.timeline.map((entry) => entry.type),
      events.map((event) => event.type),
    );
  });

  it("turns failed remediation into a gated replay regression test and candidate updates", () => {
    const postmortem = generatePostmortemFromReplay(
      resolvedIncidentEvents({
        resolvedAt: "2026-06-27T18:26:00.000Z",
        failedRemediation: true,
      }),
    );

    assert.deepEqual(postmortem.regressionTests, [
      {
        id: "regression-incident-checkout-sev1-failover-checkout-prod",
        kind: "incident-replay-regression",
        incidentId: "incident-checkout-sev1",
        sourceEventId: "incident-remediation-failed-failover-checkout-prod",
        command: [
          "hobo incident replay incident-checkout-sev1",
          "--assert failed-remediation:failover-checkout-prod",
        ].join(" "),
      },
    ]);
    assert.deepEqual(
      postmortem.candidateUpdates.map((update) => [
        update.kind,
        update.promotion,
        update.sourceEventId,
      ]),
      [
        ["runbook", "gated-eval-required", "incident-remediation-failed-failover-checkout-prod"],
        ["sre-prompt", "gated-eval-required", "incident-remediation-failed-failover-checkout-prod"],
      ],
    );
  });
});

function alertFired() {
  return {
    id: "alert-checkout-5xx",
    type: "alert.Fired",
    correlationId: "corr-checkout-sev1",
    occurredAt: "2026-06-27T18:00:00.000Z",
  };
}

function agentDispatched() {
  return {
    id: "crew-dispatch-sre",
    type: "crew.AgentDispatched",
    correlationId: "corr-checkout-sev1",
    ts: "2026-06-27T18:02:00.000Z",
    data: { agent: "sre" },
  };
}

function resolvedIncidentEvents({ resolvedAt, failedRemediation = false }) {
  const opened = makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-checkout",
    incidentId: "incident-checkout-sev1",
    correlationId: "corr-checkout-sev1",
    causationId: "alert-checkout-5xx",
    occurredAt: "2026-06-27T18:00:00.000Z",
    payload: {
      severity: "SEV1",
      impact: "checkout unavailable",
      causedBy: [
        {
          id: "alert-checkout-5xx",
          type: "alert.Fired",
          correlationId: "corr-checkout-sev1",
        },
      ],
    },
  });
  const triaged = makeIncidentEvent(INCIDENT_EVENT_TYPES.triaged, {
    id: "incident-triaged-checkout",
    incidentId: "incident-checkout-sev1",
    correlationId: "corr-checkout-sev1",
    causationId: opened.id,
    occurredAt: "2026-06-27T18:03:00.000Z",
    payload: { owner: "operator:sre" },
  });
  const rootCause = makeIncidentEvent(INCIDENT_EVENT_TYPES.rootCauseIdentified, {
    id: "incident-root-cause-checkout",
    incidentId: "incident-checkout-sev1",
    correlationId: "corr-checkout-sev1",
    causationId: triaged.id,
    occurredAt: "2026-06-27T18:07:00.000Z",
    payload: { rootCause: "provider edge degradation" },
  });
  const proposed = makeIncidentEvent(INCIDENT_EVENT_TYPES.remediationProposed, {
    id: "incident-remediation-proposed-failover-checkout-prod",
    incidentId: "incident-checkout-sev1",
    correlationId: "corr-checkout-sev1",
    causationId: rootCause.id,
    occurredAt: "2026-06-27T18:09:00.000Z",
    payload: {
      actionId: "failover-checkout-prod",
      policyDecisionId: "policy-checkout-allow",
    },
  });
  const terminal = makeIncidentEvent(
    failedRemediation
      ? INCIDENT_EVENT_TYPES.remediationFailed
      : INCIDENT_EVENT_TYPES.remediationApplied,
    {
      id: failedRemediation
        ? "incident-remediation-failed-failover-checkout-prod"
        : "incident-remediation-applied-failover-checkout-prod",
      incidentId: "incident-checkout-sev1",
      correlationId: "corr-checkout-sev1",
      causationId: proposed.id,
      occurredAt: "2026-06-27T18:12:00.000Z",
      payload: {
        actionId: "failover-checkout-prod",
        idempotencyKey: "failover-checkout-prod",
      },
    },
  );
  const resolved = makeIncidentEvent(INCIDENT_EVENT_TYPES.resolved, {
    id: "incident-resolved-checkout",
    incidentId: "incident-checkout-sev1",
    correlationId: "corr-checkout-sev1",
    causationId: terminal.id,
    occurredAt: resolvedAt,
    payload: { resolution: "checkout stabilized after failover" },
  });

  return [opened, triaged, rootCause, proposed, terminal, resolved];
}
