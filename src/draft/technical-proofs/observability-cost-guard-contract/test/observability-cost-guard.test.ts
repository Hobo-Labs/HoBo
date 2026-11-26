import assert from "node:assert/strict";
import { test } from "vitest";

import { createObservabilityCostGuard } from "../src/observability-cost-guard.js";

const CATALOG = Object.freeze({
  metrics: {
    "http.server.duration": {
      labels: ["route", "status"],
      labelBudgets: { route: 3, status: 4 }
    },
    "telemetry.guard.dropped_labels": {
      labels: ["reason"],
      labelBudgets: { reason: 4 },
      internal: true
    }
  },
  cost: {
    currency: "USD",
    unitPrices: {
      "observability-export-bytes": 0.000001,
      "observability-trace-spans": 0.00002,
      "observability-metric-series": 0.0001
    }
  }
});

test("high-cardinality metric labels are dropped or bucketed so series count stays bounded", () => {
  const guard = createObservabilityCostGuard({ catalog: CATALOG });

  for (let index = 0; index < 40; index += 1) {
    guard.recordMetric({
      name: "http.server.duration",
      value: index + 1,
      labels: {
        route: `/users/${index}`,
        status: "200",
        userId: `user-${index}`
      },
      estimatedBytes: 96
    });
  }

  const snapshot = guard.snapshot();

  assert.equal(snapshot.metrics.seriesCount, 4);
  assert.equal(snapshot.metrics.droppedLabels.userId, 40);
  assert.equal(snapshot.metrics.overflowedLabels.route, 37);
  assert.equal(snapshot.metrics.rememberedLabelValues.route, 3);
  assert.equal(snapshot.metrics.series.some((series) => series.labels.route === "other"), true);
  assert.equal(snapshot.metering.dimensions["observability-metric-series"].quantity, 4);
});

test("legitimate high-cardinality facts stay as sampled exemplars instead of labels", () => {
  const guard = createObservabilityCostGuard({ catalog: CATALOG });

  for (let index = 0; index < 12; index += 1) {
    guard.recordMetric({
      name: "http.server.duration",
      value: index,
      labels: { route: "/checkout", status: "200" },
      exemplar: { traceId: `trace-${index}`, userId: `user-${index}` },
      estimatedBytes: 96
    });
  }

  const [series] = guard.snapshot().metrics.series;

  assert.deepEqual(series.labels, { route: "/checkout", status: "200" });
  assert.equal(series.exemplar.traceId, "trace-11");
  assert.equal("userId" in series.exemplar, false);
});

test("trace floods are adaptively sampled while error traces are preserved", () => {
  const guard = createObservabilityCostGuard({
    catalog: CATALOG,
    tracePolicy: { maxNonErrorSpansPerWindow: 3 }
  });

  for (let index = 0; index < 30; index += 1) {
    guard.recordTraceSpan({
      traceId: `trace-ok-${index}`,
      spanId: `span-${index}`,
      status: "OK",
      estimatedBytes: 128
    });
  }
  guard.recordTraceSpan({
    traceId: "trace-error",
    spanId: "span-error",
    status: "ERROR",
    estimatedBytes: 256
  });

  const snapshot = guard.snapshot();

  assert.equal(snapshot.traces.exportedSpans.length, 4);
  assert.equal(snapshot.traces.droppedSampledSpans, 27);
  assert.equal(snapshot.traces.exportedSpans.some((span) => span.traceId === "trace-error"), true);
  assert.equal(snapshot.metering.dimensions["observability-trace-spans"].quantity, 4);
});

test("observability export volume is metered as its own cost dimension", () => {
  const guard = createObservabilityCostGuard({ catalog: CATALOG });

  guard.recordMetric({
    name: "http.server.duration",
    value: 42,
    labels: { route: "/checkout", status: "200" },
    estimatedBytes: 1000
  });
  guard.recordTraceSpan({
    traceId: "trace-checkout",
    spanId: "span-checkout",
    status: "OK",
    estimatedBytes: 2000
  });

  const snapshot = guard.snapshot();

  assert.equal(snapshot.metering.dimensions["observability-export-bytes"].quantity, 3000);
  assert.equal(snapshot.metering.dimensions["observability-export-bytes"].cost, 0.003);
  assert.equal(snapshot.metering.totalCost, 0.00312);
  assert.deepEqual(snapshot.metering.source, {
    type: "observability-cost-guard",
    schema: "hobo.observability-cost-guard/v1"
  });
});

test("observability budget burn sheds telemetry detail, never app traffic", () => {
  const guard = createObservabilityCostGuard({
    catalog: CATALOG,
    budget: {
      period: "2026-06",
      hardLimitUsd: 1,
      detailShedThresholdFraction: 0.8
    }
  });

  guard.recordMetric({
    name: "http.server.duration",
    value: 5,
    labels: { route: "/reports", status: "200" },
    estimatedBytes: 900000
  });

  const decision = guard.evaluateBudget();
  const accepted = guard.recordTraceSpan({
    traceId: "trace-after-shed",
    spanId: "span-low",
    status: "OK",
    priority: "low",
    estimatedBytes: 1000
  });

  assert.equal(decision.action, "shed-telemetry-detail");
  assert.equal(decision.appTraffic, "unaffected");
  assert.deepEqual(decision.obligation, {
    type: "telemetry.DetailShedRequired",
    period: "2026-06",
    preserve: ["errors", "slo-signals", "audit"]
  });
  assert.equal(accepted.exported, false);
  assert.equal(accepted.reason, "telemetry-detail-shed");
});

test("guard telemetry is suppressed from recursive metering", () => {
  const guard = createObservabilityCostGuard({ catalog: CATALOG });

  guard.recordMetric({
    name: "telemetry.guard.dropped_labels",
    value: 1,
    labels: { reason: "cardinality" },
    estimatedBytes: 1024
  });

  const snapshot = guard.snapshot();

  assert.equal(snapshot.metrics.seriesCount, 1);
  assert.equal(snapshot.metering.dimensions["observability-export-bytes"], undefined);
  assert.equal(snapshot.recursiveTelemetrySuppressed, 1);
});
