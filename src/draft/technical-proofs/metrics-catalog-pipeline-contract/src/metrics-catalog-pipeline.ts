const SOURCE = "bounded";

const label = (name, options = {}) => ({
  name,
  source: SOURCE,
  ...options,
});

const durationBucketsMs = [10, 25, 50, 100, 250, 500, 1_000, 5_000, Number.POSITIVE_INFINITY];

export const METRICS_CATALOG = {
  "control.deploy.success.total": {
    type: "counter",
    unit: "1",
    labels: [
      label("environment", { allowedValues: ["development", "preview", "staging", "production"] }),
      label("result", { allowedValues: ["success", "failure"] }),
    ],
  },
  "control.deploy.plan_to_deployed.duration_ms": {
    type: "histogram",
    unit: "ms",
    labels: [
      label("environment", { allowedValues: ["development", "preview", "staging", "production"] }),
    ],
    buckets: durationBucketsMs,
  },
  "control.provider.errors.total": {
    type: "counter",
    unit: "1",
    labels: [label("provider"), label("region"), label("operation")],
  },
  "control.executor.queue.depth": {
    type: "gauge",
    unit: "items",
    labels: [label("executorPool")],
  },
  "dataplane.service.requests.total": {
    type: "counter",
    unit: "1",
    labels: [
      label("service"),
      label("route"),
      label("method", { allowedValues: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }),
      label("statusClass", { allowedValues: ["1xx", "2xx", "3xx", "4xx", "5xx"] }),
    ],
  },
  "dataplane.service.errors.total": {
    type: "counter",
    unit: "1",
    labels: [
      label("service"),
      label("route"),
      label("method", { allowedValues: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }),
      label("statusClass", { allowedValues: ["4xx", "5xx"] }),
    ],
  },
  "dataplane.service.duration_ms": {
    type: "histogram",
    unit: "ms",
    labels: [
      label("service"),
      label("route"),
      label("method", { allowedValues: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] }),
    ],
    buckets: durationBucketsMs,
  },
  "dataplane.actor.activations.total": {
    type: "counter",
    unit: "1",
    labels: [label("actorType")],
  },
  "dataplane.queue.lag.items": {
    type: "gauge",
    unit: "items",
    labels: [label("queue")],
  },
  "runtime.wasm.component.cold_start_ms": {
    type: "histogram",
    unit: "ms",
    labels: [label("component"), label("hostKind")],
    buckets: durationBucketsMs,
  },
  "runtime.wasm.instances.per_host": {
    type: "gauge",
    unit: "instances",
    labels: [label("hostKind")],
  },
  "runtime.wasm.link.call.duration_ms": {
    type: "histogram",
    unit: "ms",
    labels: [label("import"), label("provider")],
    buckets: durationBucketsMs,
  },
  "runtime.wasm.link.call.errors.total": {
    type: "counter",
    unit: "1",
    labels: [label("import"), label("provider")],
  },
};

export function createMockOtlpCollector() {
  return {
    records: [],
    collect(records) {
      this.records.push(...records.map((record) => structuredClone(record)));
    },
  };
}

export function createMetricPipeline({ catalog = METRICS_CATALOG, collector } = {}) {
  validateCatalog(catalog);

  const series = new Map();
  const counterSamples = new Map();
  const otlpCollector = collector ?? null;

  function emitMetric({ name, labels, value }) {
    const definition = catalog[name];
    if (!definition) {
      throw new Error(`unknown metric ${name}`);
    }
    const normalizedLabels = validateLabels(name, definition, labels);
    const key = seriesKey(name, normalizedLabels);
    const existing = series.get(key);

    if (definition.type === "counter") {
      assertNonNegative(value, name);
      series.set(key, {
        name,
        type: definition.type,
        unit: definition.unit,
        labels: normalizedLabels,
        value: (existing?.value ?? 0) + value,
      });
      return;
    }

    if (definition.type === "gauge") {
      assertFiniteNumber(value, name);
      series.set(key, {
        name,
        type: definition.type,
        unit: definition.unit,
        labels: normalizedLabels,
        value,
      });
      return;
    }

    if (definition.type === "histogram") {
      assertNonNegative(value, name);
      const histogram = existing?.histogram ?? emptyHistogram(definition.buckets);
      histogram.count += 1;
      histogram.sum += value;
      const bucketIndex = histogram.buckets.findIndex((bucket) => value <= bucket);
      histogram.counts[bucketIndex] += 1;
      series.set(key, {
        name,
        type: definition.type,
        unit: definition.unit,
        labels: normalizedLabels,
        histogram,
      });
      return;
    }

    throw new Error(`unsupported metric type ${definition.type}`);
  }

  function recordDeployLifecycle({ environment, result, planStartedAtMs, deployedAtMs }) {
    if (deployedAtMs < planStartedAtMs) {
      throw new Error("deployedAtMs must be greater than or equal to planStartedAtMs");
    }
    emitMetric({
      name: "control.deploy.success.total",
      labels: { environment, result },
      value: 1,
    });
    emitMetric({
      name: "control.deploy.plan_to_deployed.duration_ms",
      labels: { environment },
      value: deployedAtMs - planStartedAtMs,
    });
  }

  function recordProviderCall({ provider, region, operation, ok }) {
    if (ok) {
      return;
    }
    emitMetric({
      name: "control.provider.errors.total",
      labels: { provider, region, operation },
      value: 1,
    });
  }

  function recordServiceRequest({
    service,
    routeTemplate,
    route: _route,
    method,
    statusCode,
    durationMs,
  }) {
    const bucketed = routeTemplate ? null : {
      bucketedRoute: "__untemplated__",
      reason: "raw route is user-sourced; routeTemplate is required for bounded cardinality",
    };
    const routeLabel = routeTemplate ?? bucketed.bucketedRoute;
    const statusClass = `${Math.trunc(statusCode / 100)}xx`;

    emitMetric({
      name: "dataplane.service.requests.total",
      labels: { service, route: routeLabel, method, statusClass },
      value: 1,
    });
    if (statusCode >= 400) {
      emitMetric({
        name: "dataplane.service.errors.total",
        labels: { service, route: routeLabel, method, statusClass },
        value: 1,
      });
    }
    emitMetric({
      name: "dataplane.service.duration_ms",
      labels: { service, route: routeLabel, method },
      value: durationMs,
    });
    return bucketed ?? undefined;
  }

  function recordCounterSample({ name, labels, sourceInstance, value }) {
    const definition = catalog[name];
    if (!definition || definition.type !== "counter") {
      throw new Error(`${name} is not a counter metric`);
    }
    assertNonNegative(value, name);
    const normalizedLabels = validateLabels(name, definition, labels);
    const sampleKey = `${name}|${sourceInstance}|${JSON.stringify(normalizedLabels)}`;
    const previous = counterSamples.get(sampleKey);
    const resetDetected = previous !== undefined && value < previous;
    const delta = resetDetected ? value : value - (previous ?? 0);
    counterSamples.set(sampleKey, value);
    emitMetric({ name, labels: normalizedLabels, value: delta });
    return { delta, resetDetected };
  }

  function recordWasmRuntimeSnapshot({
    component,
    hostKind,
    instancesPerHost,
    coldStartMs,
    linkImport,
    provider,
    linkDurationMs,
    linkOk,
  }) {
    emitMetric({
      name: "runtime.wasm.component.cold_start_ms",
      labels: { component, hostKind },
      value: coldStartMs,
    });
    emitMetric({
      name: "runtime.wasm.instances.per_host",
      labels: { hostKind },
      value: instancesPerHost,
    });
    emitMetric({
      name: "runtime.wasm.link.call.duration_ms",
      labels: { import: linkImport, provider },
      value: linkDurationMs,
    });
    if (!linkOk) {
      emitMetric({
        name: "runtime.wasm.link.call.errors.total",
        labels: { import: linkImport, provider },
        value: 1,
      });
    }
  }

  function exportOtlp() {
    const records = [...series.values()]
      .sort((left, right) =>
        seriesKey(left.name, left.labels).localeCompare(seriesKey(right.name, right.labels)),
      )
      .map((record) => ({
        resource: {
          "service.name": "hobo",
          "telemetry.sdk.name": "hobo-metrics-contract",
        },
        scope: {
          name: "@hobo-draft/metrics-catalog-pipeline-contract",
        },
        temporality: record.type === "gauge" ? "last-value" : "cumulative",
        ...structuredClone(record),
      }));
    otlpCollector?.collect(records);
    return records;
  }

  return {
    emitMetric,
    exportOtlp,
    recordCounterSample,
    recordDeployLifecycle,
    recordProviderCall,
    recordServiceRequest,
    recordWasmRuntimeSnapshot,
  };
}

function validateCatalog(catalog) {
  for (const [name, definition] of Object.entries(catalog)) {
    if (!["counter", "gauge", "histogram"].includes(definition.type)) {
      throw new Error(`${name} has unsupported metric type ${definition.type}`);
    }
    const labelNames = new Set();
    for (const labelDefinition of definition.labels ?? []) {
      if (labelDefinition.source !== SOURCE) {
        throw new Error(`${name}.${labelDefinition.name} must use bounded label source`);
      }
      if (labelNames.has(labelDefinition.name)) {
        throw new Error(`${name} repeats label ${labelDefinition.name}`);
      }
      labelNames.add(labelDefinition.name);
    }
    if (definition.type === "histogram") {
      validateBuckets(name, definition.buckets);
    }
  }
}

function validateBuckets(name, buckets) {
  if (!Array.isArray(buckets) || buckets.length < 2) {
    throw new Error(`${name} histogram buckets must include at least two buckets`);
  }
  for (let index = 1; index < buckets.length; index += 1) {
    if (buckets[index] <= buckets[index - 1]) {
      throw new Error(`${name} histogram buckets must be strictly increasing`);
    }
  }
  if (buckets.at(-1) !== Number.POSITIVE_INFINITY) {
    throw new Error(`${name} histogram buckets must end with +Inf`);
  }
}

function validateLabels(metricName, definition, labels = {}) {
  const expected = new Map(definition.labels.map((item) => [item.name, item]));
  const actual = Object.keys(labels);

  for (const labelName of actual) {
    if (!expected.has(labelName)) {
      throw new Error(`${metricName} unknown label ${labelName}`);
    }
  }

  const normalized = {};
  for (const [labelName, spec] of expected) {
    if (!(labelName in labels)) {
      throw new Error(`${metricName} missing label ${labelName}`);
    }
    const value = String(labels[labelName]);
    if (value.length === 0) {
      throw new Error(`${metricName} label ${labelName} must be non-empty`);
    }
    if (value.length > 96) {
      throw new Error(`${metricName} label ${labelName} exceeds bounded length`);
    }
    if (spec.allowedValues && !spec.allowedValues.includes(value)) {
      throw new Error(`${metricName} label ${labelName} value ${value} is not in the declared set`);
    }
    normalized[labelName] = value;
  }
  return normalized;
}

function seriesKey(name, labels) {
  return `${name}|${JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))}`;
}

function emptyHistogram(buckets) {
  return {
    buckets: [...buckets],
    counts: Array.from({ length: buckets.length }, () => 0),
    count: 0,
    sum: 0,
  };
}

function assertNonNegative(value, name) {
  assertFiniteNumber(value, name);
  if (value < 0) {
    throw new Error(`${name} value must be non-negative`);
  }
}

function assertFiniteNumber(value, name) {
  if (!Number.isFinite(value)) {
    throw new Error(`${name} value must be a finite number`);
  }
}
