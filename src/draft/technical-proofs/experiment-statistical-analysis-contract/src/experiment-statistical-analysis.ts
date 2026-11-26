const maxBasisPoints = 10_000;
const supportedOutcomes = new Set(["winner", "no-difference", "inconclusive", "do-not-ship"]);

export class ExperimentAnalysisError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ExperimentAnalysisError";
    this.code = code;
  }
}

export function analyzeExperiment(definition, input = {}) {
  const experiment = normalizeDefinition(definition);
  const seq = normalizeSeq(input.seq);
  validatePreregisteredAnalysis(experiment, input);
  const exposures = normalizeExposures(input.exposures ?? [], experiment.key);
  const metrics = normalizeMetrics(input.metrics ?? [], experiment.key);
  const variants = summarizeVariants(exposures);

  if (exposures.length === 0) {
    return buildResult(experiment, {
      outcome: "inconclusive",
      reason: "zero exposures",
      seq,
      variants
    });
  }

  const primary = comparePrimary(experiment, exposures, metrics);
  const underpowered = primary.comparisons.find((comparison) =>
    isUnderpoweredComparison(experiment, comparison)
  );

  if (underpowered || primary.comparisons.length === 0) {
    const required = underpowered
      ? requiredSampleFloor(experiment, underpowered)
      : experiment.minimumSamplesPerVariant;
    return buildResult(experiment, {
      outcome: "inconclusive",
      reason: `insufficient sample; required ${required} per variant`,
      primary,
      seq,
      variants
    });
  }

  const lookGate = evaluateLookSchedule(experiment, seq);
  if (!lookGate.allowed) {
    return buildResult(experiment, {
      outcome: "inconclusive",
      reason: lookGate.reason,
      primary,
      seq,
      variants
    });
  }

  const best = primary.comparisons[0];
  const guardrails = evaluateGuardrails(experiment, exposures, metrics, best.variant.key);

  if (best.winner && guardrails.some((guardrail) => guardrail.regressed)) {
    return buildResult(experiment, {
      outcome: "do-not-ship",
      reason: "guardrail metric regressed",
      primary: best,
      guardrails,
      seq,
      variants
    });
  }

  if (best.winner) {
    return buildResult(experiment, {
      outcome: "winner",
      reason: "primary metric improved and guardrails held",
      primary: best,
      guardrails,
      seq,
      variants,
      winningVariant: best.variant.key
    });
  }

  return buildResult(experiment, {
    outcome: "no-difference",
    reason: "primary metric confidence interval includes no material win",
    primary: best,
    guardrails,
    seq,
    variants
  });
}

function isUnderpoweredComparison(experiment, comparison) {
  const required = requiredSampleFloor(experiment, comparison);
  return comparison.control.n < required || comparison.variant.n < required;
}

function requiredSampleFloor(experiment, comparison) {
  return Math.max(experiment.minimumSamplesPerVariant, comparison.requiredSampleSize);
}

function normalizeDefinition(definition) {
  assertObject(definition, "experiment definition");
  const metrics = normalizeMetricDefinitions(definition.metrics);
  const primaryMetric = metrics.find((metric) => metric.role === "primary");
  if (!primaryMetric) {
    throw new TypeError("experiment definition requires one primary metric");
  }
  if (metrics.filter((metric) => metric.role === "primary").length !== 1) {
    throw new TypeError("experiment definition requires exactly one primary metric");
  }

  return {
    key: requireString(definition.key, "experiment key"),
    controlVariant: requireString(definition.controlVariant, "control variant"),
    minimumSamplesPerVariant: normalizePositiveInteger(
      definition.minimumSamplesPerVariant ?? 1,
      "minimumSamplesPerVariant"
    ),
    primaryConfidence: normalizeConfidence(definition.primaryConfidence ?? 0.95),
    metrics,
    primaryMetric,
    analysisPlan: normalizeAnalysisPlan(definition.analysisPlan, metrics)
  };
}

function normalizeAnalysisPlan(plan = {}, metrics) {
  assertObject(plan, "analysisPlan");
  const multipleComparisons = plan.multipleComparisons ?? "bonferroni";
  if (multipleComparisons !== "bonferroni") {
    throw new TypeError("analysisPlan.multipleComparisons must use bonferroni");
  }

  const preregisteredSegments = plan.preregisteredSegments ?? [];
  if (!Array.isArray(preregisteredSegments)) {
    throw new TypeError("analysisPlan.preregisteredSegments must be an array");
  }

  const metricFamily =
    plan.metricFamily ??
    metrics.filter((metric) => metric.role !== "guardrail").map((metric) => metric.name);
  if (!Array.isArray(metricFamily)) {
    throw new TypeError("analysisPlan.metricFamily must be an array");
  }

  const peekingProtection = plan.peekingProtection ?? "locked-schedule";
  if (peekingProtection !== "locked-schedule") {
    throw new TypeError("analysisPlan.peekingProtection must use locked-schedule");
  }

  return {
    multipleComparisons,
    metricFamily: metricFamily.map((name) => requireString(name, "metricFamily entry")),
    peekingProtection,
    lookSchedule: normalizeLookSchedule(plan.lookSchedule ?? []),
    preregisteredSegments: preregisteredSegments.map((segment) =>
      requireString(segment, "preregistered segment")
    )
  };
}

function normalizeLookSchedule(lookSchedule) {
  if (!Array.isArray(lookSchedule)) {
    throw new TypeError("analysisPlan.lookSchedule must be an array");
  }
  return lookSchedule
    .map((look) => {
      assertObject(look, "analysis look");
      return {
        seq: normalizePositiveInteger(look.seq, "analysis look seq", true)
      };
    })
    .sort((left, right) => left.seq - right.seq);
}

function validatePreregisteredAnalysis(experiment, input) {
  if (
    input.primaryMetricName !== undefined &&
    input.primaryMetricName !== experiment.primaryMetric.name
  ) {
    throw new ExperimentAnalysisError(
      "post-hoc-primary-metric",
      `primary metric ${input.primaryMetricName} was not pre-registered`
    );
  }

  if (
    input.selectedSegmentKey !== undefined &&
    !experiment.analysisPlan.preregisteredSegments.includes(input.selectedSegmentKey)
  ) {
    throw new ExperimentAnalysisError(
      "post-hoc-segment",
      `segment ${input.selectedSegmentKey} was not pre-registered`
    );
  }
}

function evaluateLookSchedule(experiment, seq) {
  const { peekingProtection, lookSchedule } = experiment.analysisPlan;
  if (peekingProtection !== "locked-schedule") {
    return { allowed: false, reason: "analysis look schedule is not locked" };
  }
  if (lookSchedule.length === 0) {
    return { allowed: false, reason: "missing locked analysis schedule" };
  }
  if (lookSchedule.some((look) => look.seq === seq)) {
    return { allowed: true };
  }
  const nextLook = lookSchedule.find((look) => look.seq > seq);
  const suffix = nextLook ? `; next scheduled seq ${nextLook.seq}` : "";
  return {
    allowed: false,
    reason: `not a scheduled analysis look${suffix}`
  };
}

function normalizeMetricDefinitions(metrics) {
  if (!Array.isArray(metrics) || metrics.length === 0) {
    throw new TypeError("experiment definition requires metrics");
  }

  return metrics.map((metric) => {
    assertObject(metric, "metric definition");
    const normalized = {
      name: requireString(metric.name, "metric name"),
      role: metric.role ?? "secondary",
      direction: metric.direction ?? "increase",
      minDetectableEffect: Number(metric.minDetectableEffect ?? 0),
      maxRegression: Number(metric.maxRegression ?? 0),
      bounds: normalizeBounds(metric.bounds)
    };

    if (!["primary", "guardrail", "secondary"].includes(normalized.role)) {
      throw new TypeError(`unknown metric role ${normalized.role}`);
    }
    if (!["increase", "decrease"].includes(normalized.direction)) {
      throw new TypeError(`unknown metric direction ${normalized.direction}`);
    }
    return normalized;
  });
}

function normalizeExposures(exposures, experimentKey) {
  if (!Array.isArray(exposures)) {
    throw new TypeError("exposures must be an array");
  }

  const seen = new Set();
  const normalized = [];
  for (const exposure of exposures) {
    const data = exposure?.data ?? exposure;
    assertObject(data, "exposure data");
    if (data.experimentKey !== experimentKey) {
      continue;
    }

    const subjectKey = requireString(data.subjectKey, "exposure subjectKey");
    const variantKey = requireString(data.variantKey, "exposure variantKey");
    const key = `${subjectKey}\0${variantKey}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    normalized.push({
      subjectKey,
      variantKey,
      samplingWeight: samplingWeight(data.sampling)
    });
  }
  return normalized;
}

function normalizeMetrics(metrics, experimentKey) {
  if (!Array.isArray(metrics)) {
    throw new TypeError("metrics must be an array");
  }

  return metrics
    .map((metric) => metric?.data ?? metric)
    .filter((metric) => metric?.experimentKey === experimentKey)
    .map((metric) => ({
      subjectKey: requireString(metric.subjectKey, "metric subjectKey"),
      variantKey: requireString(metric.variantKey, "metric variantKey"),
      metricName: requireString(metric.metricName, "metric name"),
      value: normalizeNumber(metric.value, "metric value")
    }));
}

function summarizeVariants(exposures) {
  const variants = {};
  for (const exposure of exposures) {
    variants[exposure.variantKey] ??= {
      observedExposures: 0,
      populationEstimate: 0
    };
    variants[exposure.variantKey].observedExposures += 1;
    variants[exposure.variantKey].populationEstimate = round(
      variants[exposure.variantKey].populationEstimate + exposure.samplingWeight
    );
  }
  return variants;
}

function comparePrimary(experiment, exposures, metrics) {
  const primary = experiment.primaryMetric;
  const multiplicity = multiplicityFor(experiment);
  const confidence = correctedConfidence(experiment.primaryConfidence, multiplicity);
  const control = valuesForVariant(experiment.controlVariant, primary, exposures, metrics);
  const candidates = [...new Set(exposures.map((exposure) => exposure.variantKey))]
    .filter((variantKey) => variantKey !== experiment.controlVariant)
    .map((variantKey) => {
      const variant = valuesForVariant(variantKey, primary, exposures, metrics);
      const comparison = compareMetric(primary, control, variant, confidence);
      return {
        ...comparison,
        metric: primary.name,
        confidence,
        requestedConfidence: experiment.primaryConfidence,
        multiplicity,
        control,
        variant,
        outliersClamped: control.outliersClamped + variant.outliersClamped,
        winner:
          comparison.interval.lower > 0 &&
          comparison.effect >= Number(primary.minDetectableEffect ?? 0)
      };
    })
    .sort((left, right) => right.effect - left.effect);

  return {
    metric: primary.name,
    confidence,
    requestedConfidence: experiment.primaryConfidence,
    multiplicity,
    comparisons: candidates,
    outliersClamped:
      control.outliersClamped +
      candidates.reduce((sum, comparison) => sum + comparison.variant.outliersClamped, 0)
  };
}

function multiplicityFor(experiment) {
  if (experiment.analysisPlan.multipleComparisons !== "bonferroni") {
    return {
      method: "none",
      familySize: 1,
      metrics: 1,
      segments: 1
    };
  }
  const metrics = Math.max(1, new Set(experiment.analysisPlan.metricFamily).size);
  const segments = Math.max(1, new Set(experiment.analysisPlan.preregisteredSegments).size);
  return {
    method: "bonferroni",
    familySize: metrics * segments,
    metrics,
    segments
  };
}

function correctedConfidence(confidence, multiplicity) {
  if (multiplicity.method !== "bonferroni" || multiplicity.familySize <= 1) {
    return confidence;
  }
  return 1 - (1 - confidence) / multiplicity.familySize;
}

function evaluateGuardrails(experiment, exposures, metrics, variantKey) {
  return experiment.metrics
    .filter((metric) => metric.role === "guardrail")
    .map((metric) => {
      const control = valuesForVariant(experiment.controlVariant, metric, exposures, metrics);
      const variant = valuesForVariant(variantKey, metric, exposures, metrics);
      const analysis = compareRegression(metric, control, variant, experiment.primaryConfidence);
      return {
        metric: metric.name,
        confidence: experiment.primaryConfidence,
        control,
        variant,
        regression: analysis.regression,
        interval: analysis.interval,
        requiredSampleSize: analysis.requiredSampleSize,
        maxRegression: metric.maxRegression,
        regressed: analysis.interval.lower > metric.maxRegression
      };
    });
}

function valuesForVariant(variantKey, metric, exposures, metrics) {
  const exposedSubjects = new Set(
    exposures
      .filter((exposure) => exposure.variantKey === variantKey)
      .map((exposure) => exposure.subjectKey)
  );
  const values = [];
  let outliersClamped = 0;

  for (const observation of metrics) {
    if (
      observation.variantKey !== variantKey ||
      observation.metricName !== metric.name ||
      !exposedSubjects.has(observation.subjectKey)
    ) {
      continue;
    }

    const { value, clamped } = clampMetricValue(observation.value, metric.bounds);
    outliersClamped += clamped ? 1 : 0;
    values.push(value);
  }

  return {
    key: variantKey,
    n: values.length,
    mean: round(average(values)),
    variance: round(sampleVariance(values)),
    outliersClamped
  };
}

function compareMetric(metric, control, variant, confidence) {
  const rawEffect =
    metric.direction === "increase"
      ? variant.mean - control.mean
      : control.mean - variant.mean;
  const effect = round(rawEffect);
  const margin = confidenceMargin(control, variant, confidence);
  return {
    effect,
    interval: {
      lower: round(effect - margin),
      upper: round(effect + margin)
    },
    requiredSampleSize: requiredSampleSize(metric, control.mean)
  };
}

function compareRegression(metric, control, variant, confidence) {
  const rawRegression =
    metric.direction === "increase"
      ? control.mean - variant.mean
      : variant.mean - control.mean;
  const regression = round(rawRegression);
  const margin = confidenceMargin(control, variant, confidence);
  return {
    regression,
    interval: {
      lower: round(regression - margin),
      upper: round(regression + margin)
    },
    requiredSampleSize: requiredSampleSize(metric, control.mean)
  };
}

function confidenceMargin(control, variant, confidence) {
  const stderr = Math.sqrt(
    safeVariance(control) / Math.max(control.n, 1) +
      safeVariance(variant) / Math.max(variant.n, 1)
  );
  return zForConfidence(confidence) * stderr;
}

function buildResult(experiment, details) {
  if (!supportedOutcomes.has(details.outcome)) {
    throw new TypeError(`unknown outcome ${details.outcome}`);
  }

  const eventData = {
    experimentKey: experiment.key,
    verdict: verdictForOutcome(details.outcome),
    confidence: details.primary?.confidence ?? experiment.primaryConfidence,
    reason: details.reason,
    analysisOutcome: details.outcome,
    primaryMetric: details.primary?.metric ?? experiment.primaryMetric.name,
    winningVariant: details.winningVariant
  };

  return pruneUndefined({
    outcome: details.outcome,
    primary: details.primary,
    guardrails: details.guardrails ?? [],
    variants: details.variants ?? {},
    event: {
      type: "experiment.Concluded",
      version: 1,
      id: `${experiment.key}:analysis:${details.seq}`,
      streamId: `experiment:${experiment.key}:analysis`,
      seq: details.seq,
      data: eventData
    }
  });
}

function verdictForOutcome(outcome) {
  if (outcome === "winner") {
    return "promote";
  }
  if (outcome === "do-not-ship") {
    return "rollback";
  }
  return "inconclusive";
}

function samplingWeight(sampling) {
  assertObject(sampling, "sampling marker");
  if (sampling.population === "full") {
    return 1;
  }
  if (sampling.population !== "sampled") {
    throw new ExperimentAnalysisError(
      "invalid-sampling-marker",
      "sampling marker must be full or sampled"
    );
  }

  if (
    !Number.isInteger(sampling.rateBasisPoints) ||
    sampling.rateBasisPoints <= 0 ||
    sampling.rateBasisPoints > maxBasisPoints
  ) {
    throw new ExperimentAnalysisError(
      "invalid-sampling-marker",
      "sampled exposure requires rateBasisPoints"
    );
  }
  return maxBasisPoints / sampling.rateBasisPoints;
}

function clampMetricValue(value, bounds) {
  if (!bounds) {
    return { value, clamped: false };
  }
  const [min, max] = bounds;
  if (value < min) {
    return { value: min, clamped: true };
  }
  if (value > max) {
    return { value: max, clamped: true };
  }
  return { value, clamped: false };
}

function requiredSampleSize(metric, baseline) {
  const effect = Number(metric.minDetectableEffect ?? 0);
  if (effect <= 0) {
    return 1;
  }
  const variance = Math.max(baseline * (1 - baseline), 0.01);
  return Math.ceil((16 * variance) / (effect * effect));
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values) {
  if (values.length <= 1) {
    return 0;
  }
  const mean = average(values);
  return values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
}

function safeVariance(summary) {
  if (summary.n <= 1 || summary.variance === 0) {
    return 0;
  }
  return summary.variance;
}

function zForConfidence(confidence) {
  if (confidence >= 0.999) {
    return 3.291;
  }
  if (confidence >= 0.99) {
    return 2.576;
  }
  if (confidence >= 0.985) {
    return 2.498;
  }
  if (confidence >= 0.975) {
    return 2.241;
  }
  if (confidence >= 0.95) {
    return 1.96;
  }
  if (confidence >= 0.9) {
    return 1.645;
  }
  return 1.96;
}

function normalizeBounds(bounds) {
  if (bounds === undefined) {
    return null;
  }
  if (
    !Array.isArray(bounds) ||
    bounds.length !== 2 ||
    !Number.isFinite(bounds[0]) ||
    !Number.isFinite(bounds[1]) ||
    bounds[0] > bounds[1]
  ) {
    throw new TypeError("metric bounds must be [min, max]");
  }
  return [bounds[0], bounds[1]];
}

function normalizeConfidence(value) {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new TypeError("primaryConfidence must be between 0 and 1");
  }
  return value;
}

function normalizeSeq(value) {
  return normalizePositiveInteger(value ?? 0, "seq", true);
}

function normalizePositiveInteger(value, label, allowZero = false) {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${label} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  }
  return value;
}

function normalizeNumber(value, label) {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function assertObject(value, name) {
  if (!isPlainObject(value)) {
    throw new TypeError(`${name} must be an object`);
  }
}

function requireString(value, label) {
  if (!isNonEmptyString(value)) {
    throw new TypeError(`${label} is required`);
  }
  return value;
}

function round(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function pruneUndefined(value) {
  if (Array.isArray(value)) {
    return value.map(pruneUndefined);
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .map(([key, child]) => [key, pruneUndefined(child)])
  );
}

function isPlainObject(value) {
  return value !== null && Object.prototype.toString.call(value) === "[object Object]";
}

function isNonEmptyString(value) {
  return Object.prototype.toString.call(value) === "[object String]" && value.length > 0;
}
