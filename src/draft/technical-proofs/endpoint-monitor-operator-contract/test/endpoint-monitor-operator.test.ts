import assert from "node:assert/strict";
import { describe, it } from "vitest";

import { processSreSignals } from "../../sre-operator-skeleton-contract/src/sre-operator-skeleton.js";
import {
  createEndpointMonitorOperator,
  runEndpointMonitorCycle,
} from "../src/endpoint-monitor-operator.js";

describe("Endpoint Monitor operator contract", () => {
  it("turns a synthetic probe burn into an SRE-consumable signal", () => {
    const result = runEndpointMonitorCycle({
      operator: createEndpointMonitorOperator({
        scopedCapabilities: ["synthetic:probe:api", "slo:read:checkout-availability"],
      }),
      probes: [
        probe({ id: "probe-api-1", success: false }),
        probe({ id: "probe-api-2", success: false, occurredAt: "2026-06-25T12:00:10.000Z" }),
      ],
      burnThreshold: { failedProbes: 2, window: "5m", burnRate: 14.4 },
      observedAt: "2026-06-25T12:00:30.000Z",
    });

    assert.equal(result.sloEvents.length, 1);
    assert.equal(result.sloEvents[0].type, "slo.BudgetBurned");
    assert.equal(result.alertEvents.length, 1);
    assert.equal(result.sreSignals.length, 1);
    assert.equal(result.sreSignals[0].type, "slo.BudgetBurned");

    const sre = processSreSignals({
      signals: result.sreSignals,
      dispatchAt: "2026-06-25T12:00:45.000Z",
    });

    assert.equal(sre.dispatchEvents.length, 1);
    assert.equal(sre.dispatchEvents[0].type, "crew.AgentDispatched");
    assert.equal(sre.incidentOpenedEvents.length, 1);
    assert.equal(sre.incidents[0].causedBy[0].id, result.sreSignals[0].id);
  });

  it("records CredentialAudit for probe access with token grant and use evidence", () => {
    const result = runEndpointMonitorCycle({
      operator: createEndpointMonitorOperator({
        scopedCapabilities: ["synthetic:probe:api", "slo:read:checkout-availability"],
      }),
      probes: [probe({ id: "probe-api-audit", success: true })],
      observedAt: "2026-06-25T12:05:00.000Z",
    });

    assert.deepEqual(result.credentialAudit.chains, [
      {
        agent: "agent:endpoint-monitor",
        audience: "urn:hobo:synthetic-probes",
        grants: ["grant-probe-api-audit"],
        revoked: false,
        scopes: ["synthetic:probe:api"],
        secretRefs: [],
        target: "resource:api",
        uses: ["use-probe-api-audit"],
        user: undefined,
      },
    ]);
    assert.equal(result.credentialAudit.grantsById["grant-probe-api-audit"].type, "token.Granted");
    assert.deepEqual(result.credentialAudit.anomalies, []);
  });

  it("groups flapping probe failures instead of emitting one alert per blip", () => {
    const result = runEndpointMonitorCycle({
      operator: createEndpointMonitorOperator({
        scopedCapabilities: ["synthetic:probe:api", "slo:read:checkout-availability"],
      }),
      probes: [
        probe({ id: "probe-flap-1", success: false }),
        probe({ id: "probe-flap-2", success: true, occurredAt: "2026-06-25T12:00:10.000Z" }),
        probe({ id: "probe-flap-3", success: false, occurredAt: "2026-06-25T12:00:20.000Z" }),
        probe({ id: "probe-flap-4", success: false, occurredAt: "2026-06-25T12:00:30.000Z" }),
      ],
      burnThreshold: { failedProbes: 2, window: "5m", burnRate: 14.4 },
      observedAt: "2026-06-25T12:01:00.000Z",
    });

    assert.equal(result.alertEvents.length, 1);
    assert.equal(result.alertEvents[0].type, "alert.Fired");
    assert.equal(result.alertEvents[0].data.groupKey, "endpoint-monitor|api|checkout-availability");
    assert.equal(result.alertEvents[0].data.groupedProbeCount, 4);
    assert.equal(result.sreSignals.length, 1);
  });

  it("denies probes outside the operator allow-list instead of silently skipping them", () => {
    const result = runEndpointMonitorCycle({
      operator: createEndpointMonitorOperator({
        scopedCapabilities: ["slo:read:checkout-availability"],
      }),
      probes: [probe({ id: "probe-denied", success: false })],
      observedAt: "2026-06-25T12:10:00.000Z",
    });

    assert.deepEqual(result.deniedProbes, [
      {
        probeId: "probe-denied",
        resourceId: "api",
        reason: "missing capability synthetic:probe:api",
      },
    ]);
    assert.equal(result.sloEvents.length, 0);
    assert.equal(result.alertEvents.length, 0);
    assert.equal(result.sreSignals.length, 0);
    assert.equal(result.credentialAudit.chains.length, 0);
    assert.deepEqual(result.denialEvents.map((event) => event.type), ["token.Denied"]);
  });

  it("surfaces resource drift signals into the SRE signal stream", () => {
    const result = runEndpointMonitorCycle({
      operator: createEndpointMonitorOperator({
        scopedCapabilities: ["resource:read:api"],
      }),
      probes: [],
      driftSignals: [
        {
          id: "drift-api",
          type: "resource.DriftDetected",
          resourceId: "api",
          correlationId: "corr-api-drift",
          occurredAt: "2026-06-25T12:20:00.000Z",
          payload: { field: "replicas", expected: 3, actual: 1 },
        },
      ],
      observedAt: "2026-06-25T12:20:10.000Z",
    });

    assert.deepEqual(result.sreSignals, [
      {
        id: "drift-api",
        type: "resource.DriftDetected",
        correlationId: "corr-api-drift",
        occurredAt: "2026-06-25T12:20:00.000Z",
        payload: { field: "replicas", expected: 3, actual: 1 },
      },
    ]);
  });
});

function probe(overrides = {}) {
  return {
    id: overrides.id ?? "probe-api",
    resourceId: "api",
    target: "https://api.internal/health",
    sloName: "checkout-availability",
    correlationId: "corr-api-burn",
    occurredAt: overrides.occurredAt ?? "2026-06-25T12:00:00.000Z",
    success: overrides.success ?? false,
    latencyMs: overrides.latencyMs ?? 2500,
  };
}
