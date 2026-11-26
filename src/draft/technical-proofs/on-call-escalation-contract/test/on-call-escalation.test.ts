import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { foldCrewStream } from "../../crew-event-contract/src/crew-event-contract.js";
import {
  INCIDENT_EVENT_TYPES,
  makeIncidentEvent,
} from "../../incident-aggregate-contract/src/incident-aggregate.js";
import {
  createOnCallEscalation,
  advanceOnCallEscalation,
  recordHumanDecision,
  replayOnCallEscalation,
} from "../src/on-call-escalation.js";

describe("on-call escalation contract", () => {
  it("pages on-call for an escalated SEV1 incident through a deadline obligation", () => {
    const result = createOnCallEscalation({
      incidentEvents: [sev1IncidentOpened()],
      requestedAt: "2026-06-27T16:00:00.000Z",
      ackDeadlineMinutes: 15,
    });

    assert.equal(result.status, "waiting-for-ack");
    assert.deepEqual(
      result.events.map((event) => event.type),
      ["policy.ObligationCreated", "notification.Requested", "crew.HandoffRequested"],
    );
    assert.equal(result.events[0].data.deadlineAt, "2026-06-27T16:15:00.000Z");
    assert.equal(result.events[1].data.port, "hobo:notify");
    assert.equal(result.events[1].data.receiver.name, "primary-on-call");
    assert.equal(result.events[1].data.handoffPackage.decisionRequired, "apply-fix | re-bless | abort");
    assert.equal(result.events[2].data.target.name, "primary-on-call");

    const replay = replayOnCallEscalation(result.events);
    assert.equal(replay.status, "waiting-for-ack");
    assert.equal(replay.activeReceiver.name, "primary-on-call");
    assert.equal(replay.notificationIds.length, 1);
  });

  it("escalates an unacked obligation past its deadline and records the SLA breach", () => {
    const initial = createOnCallEscalation({
      incidentEvents: [sev1IncidentOpened()],
      requestedAt: "2026-06-27T16:00:00.000Z",
      ackDeadlineMinutes: 15,
    });

    const escalation = advanceOnCallEscalation({
      events: initial.events,
      now: "2026-06-27T16:16:00.000Z",
    });

    assert.equal(escalation.status, "escalated");
    assert.deepEqual(
      escalation.events.map((event) => event.type),
      [
        "policy.ObligationEscalated",
        "notification.Requested",
        "crew.HandoffRequested",
        "incident.SLABreached",
      ],
    );
    assert.equal(escalation.events[0].data.receiver.name, "secondary-on-call");
    assert.equal(escalation.events[1].data.receiver.provider, "opsgenie-adapter-stub");
    assert.equal(escalation.events[2].causationId, initial.handoff.id);
    assert.equal(escalation.events[3].payload.objective, "incident.on-call-ack-deadline");

    const replay = replayOnCallEscalation([...initial.events, ...escalation.events]);
    assert.equal(replay.status, "escalated");
    assert.equal(replay.activeReceiver.name, "secondary-on-call");
    assert.equal(replay.slaBreaches.length, 1);

    const crewReplay = foldCrewStream(
      [...initial.events, ...escalation.events].filter((event) => event.type.startsWith("crew.")),
    );
    assert.equal(crewReplay.handoffs.length, 2);
  });

  it("records the human decision as replayable obligation satisfaction", () => {
    const initial = createOnCallEscalation({
      incidentEvents: [sev1IncidentOpened()],
      requestedAt: "2026-06-27T16:00:00.000Z",
      ackDeadlineMinutes: 15,
    });

    const decision = recordHumanDecision({
      events: initial.events,
      decidedAt: "2026-06-27T16:05:00.000Z",
      decidedBy: "user:primary-on-call",
      decision: "apply-fix",
    });

    assert.equal(decision.status, "satisfied");
    assert.deepEqual(
      decision.events.map((event) => event.type),
      ["policy.ObligationSatisfied"],
    );
    assert.deepEqual(decision.events[0].data.humanDecision, {
      decision: "apply-fix",
      decidedAt: "2026-06-27T16:05:00.000Z",
      decidedBy: "user:primary-on-call",
    });

    const replay = replayOnCallEscalation([...initial.events, ...decision.events]);
    assert.equal(replay.status, "satisfied");
    assert.equal(replay.humanDecision.decision, "apply-fix");
  });

  it("routes requiresHuman money-touching signals directly to A2H without proposing an auto-fix", () => {
    const result = createOnCallEscalation({
      incidentEvents: [moneyTouchingIncidentOpened()],
      requestedAt: "2026-06-27T16:00:00.000Z",
      requiresHuman: true,
      failingCheck: "spend-approval",
    });

    assert.equal(result.obligation.data.reason, "requiresHuman signal entered A2H directly");
    assert.deepEqual(
      result.events.map((event) => event.type),
      ["policy.ObligationCreated", "notification.Requested", "crew.HandoffRequested"],
    );
    assert.equal(result.events[2].data.target.name, "primary-on-call");
    assert.ok(!result.events.some((event) => event.type === "crew.ActionProposed"));
    assert.ok(!result.events.some((event) => event.type === INCIDENT_EVENT_TYPES.remediationProposed));
  });

  it("keeps missed deadlines open for escalation instead of silently auto-resolving them", () => {
    const initial = createOnCallEscalation({
      incidentEvents: [sev1IncidentOpened()],
      requestedAt: "2026-06-27T16:00:00.000Z",
      ackDeadlineMinutes: 15,
    });

    const beforeDeadline = advanceOnCallEscalation({
      events: initial.events,
      now: "2026-06-27T16:14:00.000Z",
    });
    const afterDeadline = advanceOnCallEscalation({
      events: initial.events,
      now: "2026-06-27T16:16:00.000Z",
    });

    assert.equal(beforeDeadline.status, "waiting-for-ack");
    assert.deepEqual(beforeDeadline.events, []);
    assert.ok(!afterDeadline.events.some((event) => event.type === "policy.ObligationSatisfied"));
    assert.equal(afterDeadline.events[0].type, "policy.ObligationEscalated");
  });
});

function sev1IncidentOpened() {
  return makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-checkout",
    incidentId: "incident-checkout-sev1",
    correlationId: "corr-checkout-sev1",
    causationId: "slo-burn-checkout",
    occurredAt: "2026-06-27T15:59:30.000Z",
    payload: {
      severity: "SEV1",
      impact: "checkout unavailable",
      causedBy: [
        {
          id: "slo-burn-checkout",
          type: "slo.BudgetBurned",
          correlationId: "corr-checkout-sev1",
        },
      ],
    },
  });
}

function moneyTouchingIncidentOpened() {
  return makeIncidentEvent(INCIDENT_EVENT_TYPES.opened, {
    id: "incident-open-spend",
    incidentId: "incident-spend-sev2",
    correlationId: "corr-spend-sev2",
    causationId: "spend-circuit-prod",
    occurredAt: "2026-06-27T15:59:30.000Z",
    payload: {
      severity: "SEV2",
      impact: "production spend circuit tripped",
      causedBy: [
        {
          id: "spend-circuit-prod",
          type: "spend.CircuitTripped",
          correlationId: "corr-spend-sev2",
        },
      ],
    },
  });
}
