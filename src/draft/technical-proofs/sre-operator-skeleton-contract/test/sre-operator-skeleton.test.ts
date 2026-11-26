import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  createSreOperator,
  processSreSignals,
} from "../src/sre-operator-skeleton.js";

describe("SRE operator skeleton", () => {
  it("dispatches SRE and opens exactly one Incident for a simulated burn signal", () => {
    const result = processSreSignals({
      signals: [
        signal("burn-api", "slo.BudgetBurned", "corr-api-burn", {
          occurredAt: "2026-06-25T12:00:00.000Z",
          payload: { service: "api", burnRate: 14.2 },
        }),
      ],
      dispatchAt: "2026-06-25T12:00:30.000Z",
    });

    assert.equal(result.dispatchEvents.length, 1);
    assert.equal(result.dispatchEvents[0].type, "crew.AgentDispatched");
    assert.equal(result.dispatchEvents[0].principal.name, "SRE");
    assert.equal(result.dispatchEvents[0].correlationId, "corr-api-burn");
    assert.equal(result.dispatchEvents[0].causationId, "burn-api");
    assert.deepEqual(result.dispatchEvents[0].data.trigger, {
      id: "burn-api",
      type: "slo.BudgetBurned",
    });

    assert.equal(result.incidentOpenedEvents.length, 1);
    assert.equal(result.incidentOpenedEvents[0].type, "incident.Opened");
    assert.equal(result.incidents.length, 1);
    assert.equal(result.incidents[0].id, "incident-corr-api-burn");
    assert.equal(result.incidents[0].status, "opened");
  });

  it("folds multiple correlated alerts into the same Incident", () => {
    const result = processSreSignals({
      signals: [
        signal("alert-1", "alert.Fired", "corr-provider-outage"),
        signal("alert-2", "alert.Fired", "corr-provider-outage"),
      ],
      dispatchAt: "2026-06-25T12:01:00.000Z",
    });

    assert.equal(result.incidentOpenedEvents.length, 1);
    assert.equal(result.dispatchEvents.length, 1);
    assert.deepEqual(
      result.incidents[0].causedBy.map((cause) => cause.id),
      ["alert-1", "alert-2"],
    );

    const replay = processSreSignals({
      signals: [signal("alert-3", "alert.Fired", "corr-provider-outage")],
      existingIncidents: result.incidents,
      dispatchAt: "2026-06-25T12:02:00.000Z",
    });

    assert.equal(replay.incidentOpenedEvents.length, 0);
    assert.equal(replay.dispatchEvents.length, 0);
    assert.equal(replay.duplicates.length, 1);
    assert.equal(replay.duplicates[0].existingIncidentId, "incident-corr-provider-outage");
  });

  it("records sre.mttd from signal occurrence to crew dispatch", () => {
    const result = processSreSignals({
      signals: [
        signal("drift-1", "resource.DriftDetected", "corr-config-drift", {
          occurredAt: "2026-06-25T12:00:00.000Z",
        }),
      ],
      dispatchAt: "2026-06-25T12:00:45.000Z",
    });

    assert.deepEqual(result.metrics, [
      {
        name: "sre.mttd",
        signalId: "drift-1",
        incidentId: "incident-corr-config-drift",
        seconds: 45,
      },
    ]);
  });

  it("does not open N incidents during an alert storm on one root cause", () => {
    const storm = Array.from({ length: 100 }, (_, index) =>
      signal(`storm-${index + 1}`, "compat.GateFailed", "corr-rollout-blocked"),
    );

    const result = processSreSignals({
      signals: storm,
      dispatchAt: "2026-06-25T12:05:00.000Z",
    });

    assert.equal(result.incidentOpenedEvents.length, 1);
    assert.equal(result.dispatchEvents.length, 1);
    assert.equal(result.incidents[0].causedBy.length, 100);
  });

  it("logs and escalates an unknown signal type instead of dropping it", () => {
    const result = processSreSignals({
      signals: [signal("unknown-1", "deploy.Surprise", "corr-unknown")],
      dispatchAt: "2026-06-25T12:10:00.000Z",
    });

    assert.equal(result.incidentOpenedEvents.length, 0);
    assert.deepEqual(result.unknownSignals, [
      {
        level: "warn",
        type: "sre.UnknownSignalLogged",
        signalId: "unknown-1",
        signalType: "deploy.Surprise",
        correlationId: "corr-unknown",
      },
    ]);
    assert.equal(result.escalations.length, 1);
    assert.equal(result.escalations[0].type, "crew.HandoffRequested");
    assert.equal(result.escalations[0].data.target.name, "on-call");
    assert.match(result.escalations[0].data.reason, /unknown signal type deploy\.Surprise/);
  });

  it("keeps dispatch and escalation events sequenced in one crew stream", () => {
    const result = processSreSignals({
      signals: [
        signal("alert-1", "alert.Fired", "corr-api"),
        signal("unknown-1", "deploy.Surprise", "corr-unknown"),
      ],
      dispatchAt: "2026-06-25T12:11:00.000Z",
    });

    assert.equal(result.dispatchEvents[0].seq, 1);
    assert.equal(result.escalations[0].seq, 2);
  });

  it("exposes the built-in SRE engine port and HolmesGPT adapter stub seam", () => {
    const builtIn = createSreOperator();
    const holmes = createSreOperator({ enginePort: "hobo:sre-engine/holmesgpt@0.1.0" });

    assert.equal(builtIn.principal.enginePort, "hobo:sre-engine/built-in@0.1.0");
    assert.equal(holmes.principal.enginePort, "hobo:sre-engine/holmesgpt@0.1.0");
    assert.deepEqual(builtIn.subscriptions, [
      "alert.*",
      "slo.BudgetBurned",
      "resource.DriftDetected",
      "compat.GateFailed",
    ]);
  });
});

function signal(id, type, correlationId, overrides = {}) {
  return {
    id,
    type,
    source: "test",
    subject: "service:api",
    correlationId,
    occurredAt: overrides.occurredAt ?? "2026-06-25T12:00:00.000Z",
    payload: overrides.payload ?? {},
  };
}
