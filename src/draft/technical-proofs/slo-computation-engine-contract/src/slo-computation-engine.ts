import {
  createGoldenSlo,
  makeSloEvent,
  parseSloDefinition,
} from "../../slo-as-code-contract/src/slo-contract.js";

export const SLO_COMPUTATION_ENGINE_VERSION = "hobo.slo-computation-engine/v1";

export function createFixtureSliSource(samples) {
  const normalized = samples.map(normalizeSample).sort(compareSampleTime);

  return {
    readRatioSamples({ from, to }) {
      const fromMs = toMillis(from);
      const toMs = toMillis(to);
      return normalized.filter((sample) => sample.timeMs > fromMs && sample.timeMs <= toMs);
    },
  };
}

export function computeSloStatus({
  definition,
  sliSource,
  now = new Date().toISOString(),
  maxStaleness = "10m",
}) {
  const parsed = parseSloDefinition(definition);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }
  if (!sliSource || !(sliSource.readRatioSamples instanceof Function)) {
    throw new Error("sliSource must expose readRatioSamples({ definition, from, to })");
  }

  const slo = parsed.slo;
  const nowMs = toMillis(now);
  const objectiveDurationMs = parseDurationMs(slo.spec.timeWindow.duration);
  const objectiveStartMs = nowMs - objectiveDurationMs;
  const objectiveSamples = sliSource
    .readRatioSamples({
      definition: slo,
      from: new Date(objectiveStartMs).toISOString(),
      to: new Date(nowMs).toISOString(),
    })
    .map(normalizeSample)
    .filter((sample) => sample.timeMs > objectiveStartMs && sample.timeMs <= nowMs)
    .sort(compareSampleTime);

  const noDataWindow = emptyWindowMetrics(slo.spec.timeWindow.duration);
  const base = {
    schema: SLO_COMPUTATION_ENGINE_VERSION,
    sloName: slo.metadata.name,
    service: slo.spec.service,
    objective: primaryObjective(slo),
    evaluatedAt: new Date(nowMs).toISOString(),
    objectiveWindow: noDataWindow,
    burnRateWindows: slo.spec.burnRateThresholds.map((threshold) => ({
      ...emptyWindowMetrics(threshold.lookbackWindow),
      name: threshold.name,
      threshold: threshold.threshold,
      lookbackWindow: threshold.lookbackWindow,
      triggered: false,
    })),
    violatedThresholds: [],
  };

  if (objectiveSamples.length === 0) {
    return {
      ...base,
      status: "no-data",
      healthy: false,
      reason: "no-sli-samples-in-objective-window",
    };
  }

  const invalidReason = validateSamples(objectiveSamples);
  if (invalidReason) {
    return {
      ...base,
      objectiveWindow: {
        ...noDataWindow,
        total: sum(objectiveSamples, "total"),
        good: sum(objectiveSamples, "good"),
        burnRate: null,
      },
      status: invalidReason.status,
      healthy: false,
      reason: invalidReason.reason,
    };
  }

  const stalenessMs = parseDurationMs(maxStaleness);
  const latestSample = objectiveSamples.at(-1);
  if (nowMs - latestSample.timeMs > stalenessMs) {
    return {
      ...base,
      objectiveWindow: computeWindowMetrics(slo, objectiveSamples, slo.spec.timeWindow.duration),
      status: "stale",
      healthy: false,
      reason: `latest-sli-sample-older-than-${maxStaleness}`,
    };
  }

  const objectiveWindow = computeWindowMetrics(slo, objectiveSamples, slo.spec.timeWindow.duration);
  const burnRateWindows = slo.spec.burnRateThresholds.map((threshold) => {
    const lookbackMs = parseDurationMs(threshold.lookbackWindow);
    const thresholdSamples = objectiveSamples.filter(
      (sample) => sample.timeMs > nowMs - lookbackMs && sample.timeMs <= nowMs,
    );
    const metrics = computeWindowMetrics(slo, thresholdSamples, threshold.lookbackWindow);
    const triggered = metrics.total > 0 && metrics.burnRate >= threshold.threshold;

    return {
      ...metrics,
      name: threshold.name,
      threshold: threshold.threshold,
      lookbackWindow: threshold.lookbackWindow,
      triggered,
    };
  });
  const violatedThresholds = burnRateWindows
    .filter((window) => window.triggered)
    .map(({ name, lookbackWindow, threshold, burnRate, remainingBudgetRatio, good, total }) => ({
      name,
      lookbackWindow,
      threshold,
      burnRate,
      remainingBudgetRatio,
      good,
      total,
    }));
  const exhausted = objectiveWindow.errors > 0 && objectiveWindow.remainingBudgetRatio === 0;
  const status = exhausted ? "budget-exhausted" : violatedThresholds.length > 0 ? "burning" : "healthy";

  return {
    ...base,
    objectiveWindow,
    burnRateWindows,
    violatedThresholds,
    status,
    healthy: status === "healthy",
  };
}

export function makeBudgetBurnedEvent(status, { id, seq, time }) {
  if (!status || status.healthy || status.status === "no-data" || status.status === "stale") {
    return null;
  }

  const window = worstBurningWindow(status);
  if (!window || window.total <= 0 || window.burnRate === null) {
    return null;
  }

  return makeSloEvent({
    id,
    type: "slo.BudgetBurned",
    sloName: status.sloName,
    seq,
    time,
    data: {
      window: window.name,
      good: window.good,
      total: window.total,
      burnRate: window.burnRate,
      remainingBudgetRatio: window.remainingBudgetRatio,
    },
  });
}

export function createBuiltInSloDefinitions() {
  return [
    createGoldenSlo({
      metadata: {
        name: "deploy-success-rate",
        labels: {
          "hobo.dev/scope": "control-plane",
        },
      },
      spec: {
        service: "deployment-control-plane",
        indicator: {
          ratioMetric: {
            counter: true,
            good: {
              telemetry: {
                query: "sum(rate(hobo_deployments_total{outcome=\"succeeded\"}[5m]))",
                unit: "deployments",
              },
            },
            total: {
              telemetry: {
                query: "sum(rate(hobo_deployments_total[5m]))",
                unit: "deployments",
              },
            },
          },
        },
        objectives: [
          {
            displayName: "deploy success rate",
            target: 0.99,
          },
        ],
      },
    }),
    createGoldenSlo({
      metadata: {
        name: "control-plane-availability",
        labels: {
          "hobo.dev/scope": "control-plane",
        },
      },
      spec: {
        service: "control-plane",
        indicator: {
          ratioMetric: {
            counter: true,
            good: {
              telemetry: {
                query: "sum(rate(hobo_control_plane_requests_total{status!~\"5..\"}[5m]))",
                unit: "requests",
              },
            },
            total: {
              telemetry: {
                query: "sum(rate(hobo_control_plane_requests_total[5m]))",
                unit: "requests",
              },
            },
          },
        },
        objectives: [
          {
            displayName: "control-plane availability",
            target: 0.999,
          },
        ],
      },
    }),
  ];
}

function computeWindowMetrics(slo, samples, window) {
  const target = primaryObjective(slo).target;
  const total = roundDecimal(sum(samples, "total"), 6);
  const good = roundDecimal(sum(samples, "good"), 6);
  const errors = roundDecimal(total - good, 6);

  if (total === 0) {
    return emptyWindowMetrics(window);
  }

  const errorBudgetRatio = 1 - target;
  const errorBudget = roundDecimal(total * errorBudgetRatio, 6);
  const burnRate = roundDecimal(errors / total / errorBudgetRatio, 3);
  const consumedBudgetRatio = errorBudget === 0 ? 1 : roundDecimal(errors / errorBudget, 6);
  const remainingBudgetRatio = roundRatio(clamp(1 - consumedBudgetRatio, 0, 1));

  return {
    window,
    good,
    total,
    errors,
    errorBudget,
    burnRate,
    consumedBudgetRatio: roundRatio(clamp(consumedBudgetRatio, 0, Number.POSITIVE_INFINITY)),
    remainingBudgetRatio,
  };
}

function emptyWindowMetrics(window) {
  return {
    window,
    good: 0,
    total: 0,
    errors: 0,
    errorBudget: 0,
    burnRate: null,
    consumedBudgetRatio: 0,
    remainingBudgetRatio: 0,
  };
}

function validateSamples(samples) {
  for (const sample of samples) {
    if (sample.good < 0 || sample.total < 0) {
      return { status: "invalid-sli-negative-count", reason: "sli-samples-must-be-non-negative" };
    }
    if (sample.good > sample.total) {
      return { status: "invalid-sli-good-greater-than-total", reason: "sli-good-must-not-exceed-total" };
    }
  }
  if (sum(samples, "total") === 0) {
    return { status: "invalid-sli-zero-total", reason: "sli-total-must-be-greater-than-zero" };
  }
  return null;
}

function worstBurningWindow(status) {
  const windows = status.violatedThresholds.length > 0 ? status.violatedThresholds : [status.objectiveWindow];
  return [...windows]
    .map((window) => ({
      ...window,
      name: window.name ?? window.window,
    }))
    .sort((a, b) => b.burnRate - a.burnRate || a.name.localeCompare(b.name))[0];
}

function primaryObjective(slo) {
  return slo.spec.objectives[0];
}

function normalizeSample(sample) {
  const timeMs = toMillis(sample.time);
  const good = Number(sample.good);
  const total = Number(sample.total);
  if (!Number.isFinite(good) || !Number.isFinite(total)) {
    throw new Error("SLI samples require finite good and total counts");
  }

  return {
    time: new Date(timeMs).toISOString(),
    timeMs,
    good,
    total,
  };
}

function toMillis(value) {
  const millis = value instanceof Date ? value.getTime() : Date.parse(value);
  if (!Number.isFinite(millis)) {
    throw new Error(`invalid timestamp: ${value}`);
  }
  return millis;
}

function parseDurationMs(duration) {
  const match = /^([1-9][0-9]*)(s|m|h|d|w|M|Q|Y)$/.exec(duration ?? "");
  if (!match) {
    throw new Error(`invalid duration: ${duration}`);
  }
  const units = {
    s: 1_000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    M: 2_592_000_000,
    Q: 7_776_000_000,
    Y: 31_536_000_000,
  };
  return Number(match[1]) * units[match[2]];
}

function compareSampleTime(a, b) {
  return a.timeMs - b.timeMs;
}

function sum(samples, key) {
  return samples.reduce((total, sample) => total + sample[key], 0);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundRatio(value) {
  return roundDecimal(value, 6);
}

function roundDecimal(value, places) {
  return Number(value.toFixed(places));
}
