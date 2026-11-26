import { isJsonString, isJsonNumber, isJsonObject } from "./json.js";
export const OBSERVABILITY_COST_GUARD_SCHEMA = "hobo.observability-cost-guard/v1";

const DEFAULT_TRACE_POLICY = Object.freeze({
  maxNonErrorSpansPerWindow: 100
});

const DEFAULT_BUDGET = Object.freeze({
  period: "unbounded",
  hardLimitUsd: Number.POSITIVE_INFINITY,
  detailShedThresholdFraction: 0.8
});

export function createObservabilityCostGuard(options = {}) {
  const catalog = normalizeCatalog(options.catalog);
  const tracePolicy = {
    ...DEFAULT_TRACE_POLICY,
    ...options.tracePolicy
  };
  const budget = normalizeBudget(options.budget);
  const state = {
    metricSeries: new Map(),
    droppedLabels: new Map(),
    overflowedLabels: new Map(),
    labelValues: new Map(),
    exportedSpans: [],
    droppedSampledSpans: 0,
    exportedBytes: 0,
    exportedTraceSpanCount: 0,
    recursiveTelemetrySuppressed: 0,
    nonErrorTraceSpanCount: 0,
    detailShedding: false
  };

  return {
    recordMetric(metric) {
      const definition = metricDefinition(catalog, metric.name);
      const sanitized = sanitizeLabels(metric.name, definition, metric.labels ?? {}, state);
      const key = metricSeriesKey(metric.name, sanitized.labels);
      const current = state.metricSeries.get(key) ?? {
        name: metric.name,
        labels: sanitized.labels,
        points: 0,
        latestValue: null,
        exemplar: null,
        internal: definition.internal === true
      };

      current.points += 1;
      current.latestValue = requireFiniteNumber(metric.value, "metric.value");
      current.exemplar = sanitizeExemplar(metric.exemplar);
      state.metricSeries.set(key, current);

      if (definition.internal === true) {
        state.recursiveTelemetrySuppressed += 1;
      } else {
        state.exportedBytes += nonNegativeInteger(metric.estimatedBytes ?? 0, "metric.estimatedBytes");
      }

      return {
        accepted: true,
        labels: sanitized.labels,
        exemplar: current.exemplar,
        droppedLabels: sanitized.droppedLabels,
        overflowedLabels: sanitized.overflowedLabels
      };
    },

    recordTraceSpan(span) {
      const normalized = normalizeTraceSpan(span);
      const isError = normalized.status === "ERROR";
      const preserveDuringShed = isError || normalized.priority === "audit" || normalized.priority === "slo";

      if (state.detailShedding && !preserveDuringShed) {
        return { exported: false, reason: "telemetry-detail-shed" };
      }

      if (!isError && state.nonErrorTraceSpanCount >= tracePolicy.maxNonErrorSpansPerWindow) {
        state.droppedSampledSpans += 1;
        return { exported: false, reason: "adaptive-sampling" };
      }

      if (!isError) {
        state.nonErrorTraceSpanCount += 1;
      }

      state.exportedSpans.push(normalized);
      state.exportedTraceSpanCount += 1;
      state.exportedBytes += normalized.estimatedBytes;

      return { exported: true, span: normalized };
    },

    evaluateBudget() {
      const metering = meteringSnapshot(state, catalog);
      const thresholdUsd = roundCost(budget.hardLimitUsd * budget.detailShedThresholdFraction);

      if (metering.totalCost >= thresholdUsd) {
        state.detailShedding = true;
        return {
          action: "shed-telemetry-detail",
          appTraffic: "unaffected",
          totalCost: metering.totalCost,
          thresholdUsd,
          obligation: {
            type: "telemetry.DetailShedRequired",
            period: budget.period,
            preserve: ["errors", "slo-signals", "audit"]
          }
        };
      }

      return {
        action: "allow",
        appTraffic: "unaffected",
        totalCost: metering.totalCost,
        thresholdUsd
      };
    },

    snapshot() {
      return {
        schema: OBSERVABILITY_COST_GUARD_SCHEMA,
        metrics: metricSnapshot(state),
        traces: {
          exportedSpans: state.exportedSpans.map(cloneValue),
          droppedSampledSpans: state.droppedSampledSpans
        },
        metering: meteringSnapshot(state, catalog),
        recursiveTelemetrySuppressed: state.recursiveTelemetrySuppressed,
        detailShedding: state.detailShedding
      };
    }
  };
}

function normalizeCatalog(catalog) {
  if (!catalog || !isJsonObject(catalog) || Array.isArray(catalog)) {
    throw new TypeError("catalog must be an object");
  }
  if (!catalog.metrics || !isJsonObject(catalog.metrics) || Array.isArray(catalog.metrics)) {
    throw new TypeError("catalog.metrics must be an object");
  }
  if (!catalog.cost || !isJsonObject(catalog.cost) || Array.isArray(catalog.cost)) {
    throw new TypeError("catalog.cost must be an object");
  }
  if (!catalog.cost.unitPrices || !isJsonObject(catalog.cost.unitPrices)) {
    throw new TypeError("catalog.cost.unitPrices must be an object");
  }

  return {
    metrics: catalog.metrics,
    cost: {
      currency: requireString(catalog.cost.currency, "catalog.cost.currency"),
      unitPrices: catalog.cost.unitPrices
    }
  };
}

function normalizeBudget(input) {
  if (!input) {
    return { ...DEFAULT_BUDGET };
  }

  const hardLimitUsd =
    input.hardLimitUsd === undefined
      ? DEFAULT_BUDGET.hardLimitUsd
      : requirePositiveNumber(input.hardLimitUsd, "budget.hardLimitUsd");
  const detailShedThresholdFraction =
    input.detailShedThresholdFraction === undefined
      ? DEFAULT_BUDGET.detailShedThresholdFraction
      : requireFraction(input.detailShedThresholdFraction, "budget.detailShedThresholdFraction");

  return {
    period: input.period ?? DEFAULT_BUDGET.period,
    hardLimitUsd,
    detailShedThresholdFraction
  };
}

function metricDefinition(catalog, name) {
  const definition = catalog.metrics[name];
  if (!definition) {
    throw new Error(`metric ${name} is not declared in catalog`);
  }
  if (!Array.isArray(definition.labels)) {
    throw new TypeError(`metric ${name} labels must be an array`);
  }
  return definition;
}

function sanitizeLabels(metricName, definition, labels, state) {
  const allowed = new Set(definition.labels);
  const sanitized = {};
  const droppedLabels = [];
  const overflowedLabels = [];

  for (const [key, value] of Object.entries(labels)) {
    if (!allowed.has(key)) {
      incrementMap(state.droppedLabels, key);
      droppedLabels.push(key);
      continue;
    }

    const normalizedValue = String(value);
    const budget = definition.labelBudgets?.[key];
    const valueKey = `${metricName}:${key}`;
    const seen = state.labelValues.get(valueKey) ?? new Set();

    if (Number.isInteger(budget) && budget >= 0 && !seen.has(normalizedValue) && seen.size >= budget) {
      sanitized[key] = "other";
      incrementMap(state.overflowedLabels, key);
      overflowedLabels.push(key);
      continue;
    }

    seen.add(normalizedValue);
    state.labelValues.set(valueKey, seen);
    sanitized[key] = normalizedValue;
  }

  for (const key of definition.labels) {
    if (!(key in sanitized)) {
      sanitized[key] = "unknown";
    }
  }

  return { labels: sanitized, droppedLabels, overflowedLabels };
}

function sanitizeExemplar(exemplar) {
  if (!exemplar) {
    return null;
  }
  if (!isJsonObject(exemplar) || Array.isArray(exemplar)) {
    throw new TypeError("metric.exemplar must be an object");
  }

  const sampled = {};
  for (const key of ["traceId", "spanId"]) {
    if (exemplar[key] !== undefined) {
      sampled[key] = String(exemplar[key]);
    }
  }
  return Object.keys(sampled).length > 0 ? sampled : null;
}

function normalizeTraceSpan(span) {
  if (!span || !isJsonObject(span) || Array.isArray(span)) {
    throw new TypeError("span must be an object");
  }

  return {
    traceId: requireString(span.traceId, "span.traceId"),
    spanId: requireString(span.spanId, "span.spanId"),
    status: (span.status ?? "OK").toUpperCase(),
    priority: span.priority ?? "normal",
    estimatedBytes: nonNegativeInteger(span.estimatedBytes ?? 0, "span.estimatedBytes"),
    attributes: cloneValue(span.attributes ?? {})
  };
}

function metricSnapshot(state) {
  const series = [...state.metricSeries.values()].map((entry) => ({
    name: entry.name,
    labels: cloneValue(entry.labels),
    points: entry.points,
    latestValue: entry.latestValue,
    exemplar: cloneValue(entry.exemplar),
    internal: entry.internal
  }));

  series.sort((a, b) => metricSeriesKey(a.name, a.labels).localeCompare(metricSeriesKey(b.name, b.labels)));

  return {
    seriesCount: series.length,
    series,
    droppedLabels: Object.fromEntries(state.droppedLabels),
    overflowedLabels: Object.fromEntries(state.overflowedLabels),
    rememberedLabelValues: rememberedLabelValueSnapshot(state.labelValues)
  };
}

function rememberedLabelValueSnapshot(labelValues) {
  const snapshot = {};
  for (const [key, values] of labelValues.entries()) {
    const [, labelName] = key.split(":");
    snapshot[labelName] = Math.max(snapshot[labelName] ?? 0, values.size);
  }
  return snapshot;
}

function meteringSnapshot(state, catalog) {
  const dimensions = {};
  const externalSeriesCount = [...state.metricSeries.values()].filter((series) => !series.internal).length;

  addMeteredDimension(
    dimensions,
    catalog,
    "observability-export-bytes",
    state.exportedBytes
  );
  addMeteredDimension(
    dimensions,
    catalog,
    "observability-trace-spans",
    state.exportedTraceSpanCount
  );
  addMeteredDimension(
    dimensions,
    catalog,
    "observability-metric-series",
    externalSeriesCount
  );

  for (const [dimension, value] of Object.entries(dimensions)) {
    if (value.quantity === 0) {
      delete dimensions[dimension];
    }
  }

  return {
    source: {
      type: "observability-cost-guard",
      schema: OBSERVABILITY_COST_GUARD_SCHEMA
    },
    currency: catalog.cost.currency,
    dimensions,
    totalCost: roundCost(
      Object.values(dimensions).reduce((total, dimension) => total + dimension.cost, 0)
    )
  };
}

function addMeteredDimension(dimensions, catalog, dimension, quantity) {
  const unitPrice = catalog.cost.unitPrices[dimension];
  if (unitPrice === undefined) {
    throw new Error(`missing unit price for ${dimension}`);
  }

  dimensions[dimension] = {
    quantity,
    unitPrice,
    cost: roundCost(quantity * unitPrice),
    currency: catalog.cost.currency
  };
}

function metricSeriesKey(name, labels) {
  const labelPart = Object.entries(labels)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${name}{${labelPart}}`;
}

function incrementMap(map, key) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function nonNegativeInteger(value, fieldName) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${fieldName} must be a non-negative integer`);
  }
  return value;
}

function requireString(value, fieldName) {
  if (!isJsonString(value) || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty string`);
  }
  return value;
}

function requireFiniteNumber(value, fieldName) {
  if (!isJsonNumber(value) || !Number.isFinite(value)) {
    throw new TypeError(`${fieldName} must be a finite number`);
  }
  return value;
}

function requirePositiveNumber(value, fieldName) {
  if (!isJsonNumber(value) || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${fieldName} must be a positive number`);
  }
  return value;
}

function requireFraction(value, fieldName) {
  if (!isJsonNumber(value) || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`${fieldName} must be in the range (0, 1]`);
  }
  return value;
}

function roundCost(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}
