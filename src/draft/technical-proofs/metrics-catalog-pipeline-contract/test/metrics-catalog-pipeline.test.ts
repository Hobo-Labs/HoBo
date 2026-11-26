import assert from "node:assert/strict";
import { describe, it } from "vitest";

import {
  METRICS_CATALOG,
  createMetricPipeline,
  createMockOtlpCollector,
} from "../src/metrics-catalog-pipeline.js";
import { isJsonString } from "../src/json.js";

const names = (records) => records.map((record) => record.name).sort();

describe("metrics catalog pipeline contract", () => {
  it("declares control-plane, data-plane RED, and wasm-runtime metrics with bounded labels", () => {
    assert.deepEqual(
      [
        "control.deploy.plan_to_deployed.duration_ms",
        "control.deploy.success.total",
        "control.provider.errors.total",
        "dataplane.service.duration_ms",
        "dataplane.service.errors.total",
        "dataplane.service.requests.total",
        "runtime.wasm.component.cold_start_ms",
        "runtime.wasm.instances.per_host",
        "runtime.wasm.link.call.duration_ms",
        "runtime.wasm.link.call.errors.total",
      ].filter((name) => !METRICS_CATALOG[name]),
      [],
    );

    for (const [metricName, definition] of Object.entries(METRICS_CATALOG)) {
      assert.equal(isJsonString(definition.unit), true, `${metricName} unit`);
      assert.match(definition.type, /^(counter|gauge|histogram)$/);
      assert.ok(Array.isArray(definition.labels), `${metricName} labels`);
      for (const label of definition.labels) {
        assert.equal(label.source, "bounded", `${metricName}.${label.name} is bounded`);
      }
    }
  });

  it("emits deploy success and plan-to-deployed latency to a mock OTLP collector", () => {
    const collector = createMockOtlpCollector();
    const pipeline = createMetricPipeline({ collector });

    pipeline.recordDeployLifecycle({
      environment: "production",
      result: "success",
      planStartedAtMs: 1_000,
      deployedAtMs: 1_450,
    });

    const exported = pipeline.exportOtlp();
    assert.deepEqual(names(exported), [
      "control.deploy.plan_to_deployed.duration_ms",
      "control.deploy.success.total",
    ]);
    assert.deepEqual(collector.records, exported);

    const success = exported.find((record) => record.name === "control.deploy.success.total");
    assert.equal(success.value, 1);
    assert.deepEqual(success.labels, { environment: "production", result: "success" });

    const latency = exported.find(
      (record) => record.name === "control.deploy.plan_to_deployed.duration_ms",
    );
    assert.equal(latency.histogram.count, 1);
    assert.equal(latency.histogram.sum, 450);
    assert.equal(latency.unit, "ms");
  });

  it("keys provider error metrics by provider, region, and operation", () => {
    const pipeline = createMetricPipeline();

    pipeline.recordProviderCall({
      provider: "aws",
      region: "us-east-1",
      operation: "s3.putObject",
      ok: false,
    });
    pipeline.recordProviderCall({
      provider: "aws",
      region: "us-east-1",
      operation: "s3.putObject",
      ok: true,
    });

    const errors = pipeline.exportOtlp().find(
      (record) => record.name === "control.provider.errors.total",
    );
    assert.equal(errors.value, 1);
    assert.deepEqual(errors.labels, {
      provider: "aws",
      region: "us-east-1",
      operation: "s3.putObject",
    });
  });

  it("emits data-plane RED metrics for service requests", () => {
    const pipeline = createMetricPipeline();

    pipeline.recordServiceRequest({
      service: "checkout-api",
      routeTemplate: "GET /orders/:id",
      method: "GET",
      statusCode: 503,
      durationMs: 37,
    });

    const exported = pipeline.exportOtlp();
    assert.deepEqual(names(exported), [
      "dataplane.service.duration_ms",
      "dataplane.service.errors.total",
      "dataplane.service.requests.total",
    ]);
    for (const record of exported) {
      assert.equal(record.labels.service, "checkout-api");
      assert.equal(record.labels.route, "GET /orders/:id");
      assert.equal(record.labels.method, "GET");
    }
    assert.equal(
      exported.find((record) => record.name === "dataplane.service.errors.total").value,
      1,
    );
  });

  it("emits wasm-runtime cold-start, density, and link-call metrics", () => {
    const pipeline = createMetricPipeline();

    pipeline.recordWasmRuntimeSnapshot({
      component: "checkout-api",
      hostKind: "wasm-in-container",
      instancesPerHost: 17,
      coldStartMs: 24,
      linkImport: "hobo:keyvalue/cache",
      provider: "redis",
      linkDurationMs: 8,
      linkOk: false,
    });

    const exported = pipeline.exportOtlp();
    assert.deepEqual(names(exported), [
      "runtime.wasm.component.cold_start_ms",
      "runtime.wasm.instances.per_host",
      "runtime.wasm.link.call.duration_ms",
      "runtime.wasm.link.call.errors.total",
    ]);
    assert.equal(
      exported.find((record) => record.name === "runtime.wasm.instances.per_host").value,
      17,
    );
    assert.equal(
      exported.find((record) => record.name === "runtime.wasm.link.call.errors.total").value,
      1,
    );
  });

  it("rejects unbounded labels and buckets raw user routes before export", () => {
    const pipeline = createMetricPipeline();

    assert.throws(
      () =>
        pipeline.emitMetric({
          name: "dataplane.service.requests.total",
          labels: {
            service: "checkout-api",
            route: "GET /orders/:id",
            method: "GET",
            statusClass: "2xx",
            userId: "user-123",
          },
          value: 1,
        }),
      /unknown label userId/,
    );

    const warning = pipeline.recordServiceRequest({
      service: "checkout-api",
      route: "/orders/12345",
      method: "GET",
      statusCode: 200,
      durationMs: 12,
    });
    assert.deepEqual(warning, {
      bucketedRoute: "__untemplated__",
      reason: "raw route is user-sourced; routeTemplate is required for bounded cardinality",
    });

    const request = pipeline.exportOtlp().find(
      (record) => record.name === "dataplane.service.requests.total",
    );
    assert.equal(request.labels.route, "__untemplated__");
  });

  it("keeps counter samples monotonic across actor restarts", () => {
    const pipeline = createMetricPipeline();

    assert.deepEqual(
      pipeline.recordCounterSample({
        name: "dataplane.actor.activations.total",
        labels: { actorType: "ResourceActor" },
        sourceInstance: "actor-host-a",
        value: 5,
      }),
      { delta: 5, resetDetected: false },
    );
    assert.deepEqual(
      pipeline.recordCounterSample({
        name: "dataplane.actor.activations.total",
        labels: { actorType: "ResourceActor" },
        sourceInstance: "actor-host-a",
        value: 1,
      }),
      { delta: 1, resetDetected: true },
    );

    const counter = pipeline.exportOtlp().find(
      (record) => record.name === "dataplane.actor.activations.total",
    );
    assert.equal(counter.value, 6);
  });

  it("fails closed for mis-sized histogram buckets", () => {
    const badCatalog = {
      ...METRICS_CATALOG,
      "dataplane.service.duration_ms": {
        ...METRICS_CATALOG["dataplane.service.duration_ms"],
        buckets: [100, 50, Number.POSITIVE_INFINITY],
      },
    };

    assert.throws(
      () => createMetricPipeline({ catalog: badCatalog }),
      /histogram buckets must be strictly increasing/,
    );
  });

  it("fails closed when a metric is emitted before its declared labels are known", () => {
    const pipeline = createMetricPipeline();

    assert.throws(
      () =>
        pipeline.emitMetric({
          name: "control.provider.errors.total",
          labels: { provider: "aws", operation: "s3.putObject" },
          value: 1,
        }),
      /missing label region/,
    );
  });
});
