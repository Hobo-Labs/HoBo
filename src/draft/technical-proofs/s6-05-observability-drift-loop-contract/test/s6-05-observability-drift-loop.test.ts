import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  evaluateSloBurnAlert,
  exportControlAndDataPlaneTelemetry,
  getDrift,
  healDrift,
  runDriftLoop,
  runDriftSchedulerTick,
  runObservabilityDriftLoopE2E,
} from "../src/s6-05-observability-drift-loop.js";

const TRACEPARENT = "00-11111111111111111111111111111111-2222222222222222-01";
const NOW = "2026-07-02T03:00:00.000Z";

describe("S6-05 observability drift loop E2E", () => {
  it("exports deploy and run traces with OTLP metrics and structured logs", () => {
    const telemetry = exportControlAndDataPlaneTelemetry({
      traceparent: TRACEPARENT,
      tenant: "tenant-a",
      deploymentId: "deploy-api-prod",
      runId: "run-checkout-42",
      now: NOW,
    });

    assert.ok(telemetry.deploy.exportedSpans > 0, "deploy trace must export spans");
    assert.ok(telemetry.run.exportedSpans > 0, "run trace must export spans");
    assert.equal(telemetry.run.parentTraceId, telemetry.deploy.traceId);
    assert.ok(telemetry.metrics.exportedSeries > 0);
    assert.ok(telemetry.otlp.traceCollectorExports > 0);
    assert.ok(telemetry.otlp.metricCollectorExports > 0);
    assert.ok(telemetry.logs.entries > 0);
    assert.equal(telemetry.logs.correlatedToTrace, true);
  });

  it("fires an alert when a seeded SLO burn breaches burn-rate thresholds", () => {
    const slo = evaluateSloBurnAlert({ now: NOW });

    assert.equal(slo.status.healthy, false);
    assert.ok(slo.budgetEvent);
    assert.equal(slo.budgetEvent.type, "slo.BudgetBurned");
    assert.equal(slo.fired, true);
    assert.ok(slo.alertEvents.some((event) => event.type === "alert.Fired"));
    assert.ok(slo.alertEvents.some((event) => event.type === "alert.Routed"));
  });

  it("detects injected provider drift and heals with drift.* events", async () => {
    const drift = await runDriftLoop({
      resources: [{ id: "api", desiredRef: "set:desired@sha256-good" }],
      providerState: { api: "provider:observed@sha256-drifted" },
      now: NOW,
    });

    assert.equal(drift.detected.length, 1);
    assert.equal(drift.detected[0].type, "resource.DriftDetected");
    assert.equal(drift.healResults[0].status, "applied");
    assert.ok(drift.allDriftEvents.some((event) => event.type === "drift.RemediationRouted"));
  });

  it("satisfies full acceptance lane for telemetry, SLO burn alert, and drift heal", async () => {
    const result = await runObservabilityDriftLoopE2E({
      resources: [{ id: "api", desiredRef: "set:desired@sha256-good" }],
      providerState: { api: "provider:observed@sha256-drifted" },
      now: NOW,
    });

    assert.equal(result.acceptance.deployTraceExported, true);
    assert.equal(result.acceptance.runTraceExported, true);
    assert.equal(result.acceptance.sloBurnAlertFired, true);
    assert.equal(result.acceptance.driftHealed, true);
    assert.equal(result.acceptance.driftEventsEmitted, true);
  });
});

describe("drift scheduler and MCP surfaces", () => {
  it("periodic resync tick detects only diverged resources", () => {
    const tick = runDriftSchedulerTick({
      resources: [
        { id: "api", desiredRef: "set:desired@good" },
        { id: "cache", desiredRef: "set:desired@cache" },
      ],
      providerState: {
        api: "provider:observed@drifted",
        cache: "set:desired@cache",
      },
      now: NOW,
    });

    assert.equal(tick.detected.length, 1);
    assert.equal(tick.detected[0].resourceId, "api");
  });

  it("get_drift returns projection entries for a resource", async () => {
    const drift = await runDriftLoop({
      resources: [{ id: "api", desiredRef: "set:desired@sha256-good" }],
      providerState: { api: "provider:observed@sha256-drifted" },
      policies: { api: { mode: "propose", environment: "prod" } },
      now: NOW,
    });
    const projection = getDrift({ resourceId: "api", projection: drift.projection });

    assert.equal(projection.count, 1);
    assert.equal(projection.drift[0].resourceId, "api");
    assert.equal(projection.drift[0].remediation, "proposed");
  });

  it("heal MCP action routes heal policy through drift remediation", async () => {
    const drift = await runDriftLoop({
      resources: [{ id: "api", desiredRef: "set:desired@sha256-good" }],
      providerState: { api: "provider:observed@sha256-drifted" },
      policies: { api: { mode: "propose", environment: "staging" } },
      now: NOW,
    });
    const healed = await healDrift({
      resourceId: "api",
      projection: drift.projection,
      now: NOW,
    });

    assert.equal(healed.status, "applied");
    assert.ok(healed.events.some((event) => event.type === "drift.RemediationRouted"));
  });
});

describe("adversarial guards", () => {
  it("does not fire alerts when SLO samples are healthy", () => {
    const slo = evaluateSloBurnAlert({
      now: NOW,
      sliSamples: Array.from({ length: 60 }, (_, index) => ({
        time: new Date(Date.parse(NOW) - index * 60_000).toISOString(),
        good: 1000,
        total: 1000,
      })),
    });

    assert.equal(slo.budgetEvent, null);
    assert.equal(slo.fired, false);
    assert.deepEqual(slo.alertEvents, []);
  });

  it("propose drift policy emits drift.DiffProposed without auto-heal", async () => {
    const drift = await runDriftLoop({
      resources: [{ id: "billing-db", desiredRef: "set:desired@sha256-good" }],
      providerState: { "billing-db": "provider:observed@sha256-drifted" },
      policies: { "billing-db": { mode: "propose", environment: "prod" } },
      now: NOW,
    });

    assert.equal(drift.healResults[0].status, "proposed");
    assert.ok(drift.allDriftEvents.some((event) => event.type === "drift.DiffProposed"));
    assert.ok(!drift.allDriftEvents.some((event) => event.type === "drift.RemediationRouted"));
  });

  it("ignore drift policy records drift.Ignored without write actions", async () => {
    const drift = await runDriftLoop({
      resources: [{ id: "legacy-cache", desiredRef: "set:desired@cache" }],
      providerState: { "legacy-cache": "provider:observed@drifted" },
      policies: { "legacy-cache": { mode: "ignore", reason: "detect-only" } },
      now: NOW,
    });

    assert.equal(drift.healResults[0].status, "ignored");
    assert.deepEqual(drift.allDriftEvents.map((event) => event.type), ["drift.Ignored"]);
  });
});
