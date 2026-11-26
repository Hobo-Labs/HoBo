import { evaluateRolloutMetricGate, stableDigest } from "../../slo-gated-rollback-analysis-contract/src/slo-gated-rollback-analysis.js";
import { isJsonString, isJsonObject } from "./json.js";


export const SPIKE_SCHEMA = "hobo.slo-rollback-decision-correctness/v1";

export const RECOMMENDED_POLICY = Object.freeze({
  name: "recommended-15m-sustained-breach",
  analysisWindow: "15m",
  holdBurnRate: 1,
  rollbackBurnRate: 12,
  minRemainingBudgetRatio: 0.08,
  holdRemainingBudgetRatio: 0.2,
  sustainedBreachCount: 2,
  sustainedHealthyCount: 2,
});

export const SHORT_WINDOW_POLICY = Object.freeze({
  ...RECOMMENDED_POLICY,
  name: "too-short-5m-window",
  analysisWindow: "5m",
});

export const TIGHT_THRESHOLD_POLICY = Object.freeze({
  ...RECOMMENDED_POLICY,
  name: "too-tight-one-sample",
  analysisWindow: "5m",
  rollbackBurnRate: 10,
  sustainedBreachCount: 1,
  sustainedHealthyCount: 1,
});

export function runReplayCorpus(corpus, policy = RECOMMENDED_POLICY) {
  validateCorpus(corpus);
  const results = corpus.fixtures.map((fixture) => evaluateFixture(corpus.rollout, fixture, policy));
  const metrics = computeMetrics(results);

  return deepFreeze({
    schema: SPIKE_SCHEMA,
    policy: cloneJson(policy),
    corpusDigest: stableDigest(corpus),
    results,
    metrics,
  });
}

export function buildRecommendationReport(corpus) {
  const recommended = runReplayCorpus(corpus, RECOMMENDED_POLICY);
  const shortWindow = runReplayCorpus(corpus, SHORT_WINDOW_POLICY);
  const tightThreshold = runReplayCorpus(corpus, TIGHT_THRESHOLD_POLICY);

  return deepFreeze({
    schema: SPIKE_SCHEMA,
    decision: "use-15m-window-with-two-sample-breach-and-health-hysteresis",
    recommendation: {
      analysisWindow: RECOMMENDED_POLICY.analysisWindow,
      holdBurnRate: RECOMMENDED_POLICY.holdBurnRate,
      rollbackBurnRate: RECOMMENDED_POLICY.rollbackBurnRate,
      minRemainingBudgetRatio: RECOMMENDED_POLICY.minRemainingBudgetRatio,
      holdRemainingBudgetRatio: RECOMMENDED_POLICY.holdRemainingBudgetRatio,
      sustainedBreachCount: RECOMMENDED_POLICY.sustainedBreachCount,
      sustainedHealthyCount: RECOMMENDED_POLICY.sustainedHealthyCount,
    },
    recommended,
    comparisons: {
      shortWindow,
      tightThreshold,
    },
    evidence: {
      shortWindowMissesSlowBurn: verdictFor(shortWindow, "slow-burn-bad") !== "rollback",
      hysteresisSuppressesTransientBlip: verdictFor(recommended, "transient-blip-good") !== "rollback" &&
        verdictFor(tightThreshold, "transient-blip-good") === "rollback",
    },
    invariants: {
      failSafeOnMissingData: verdictFor(recommended, "missing-data-interval") === "hold",
      noOscillation: verdictFor(recommended, "transient-blip-good") === "hold",
      replayableVerdict: recommended.results.every((result) => result.inputHash === stableDigest(result.evidence)),
    },
  });
}

function evaluateFixture(rollout, fixture, policy) {
  const samples = normalizeSamples(fixture.samples);
  const latest = samples.at(-1);
  const windowSamples = samplesWithinWindow(samples, latest.observedAt, policy.analysisWindow);
  const result = evaluateRolloutMetricGate({
    rollout,
    policy,
    sloSnapshot: latest,
    windowSamples,
    goldenSuite: fixture.goldenSuite,
    now: latest.observedAt,
  });
  const decisionEvent = result.events[0];

  return deepFreeze({
    id: requiredString(fixture.id, "fixture.id"),
    label: requiredString(fixture.label, "fixture.label"),
    expectedVerdict: requiredString(fixture.expectedVerdict, "fixture.expectedVerdict"),
    verdict: result.verdict,
    reason: result.reason,
    correct: verdictMatchesLabel(fixture.label, result.verdict),
    windowSampleSeqs: windowSamples.map((sample) => sample.seq),
    eventTypes: result.events.map((event) => event.type),
    inputHash: decisionEvent.data.inputHash,
    evidence: decisionEvent.data.evidence,
  });
}

function computeMetrics(results) {
  const good = results.filter((result) => result.label === "good");
  const bad = results.filter((result) => result.label === "bad");
  const falsePositives = good.filter((result) => result.verdict === "rollback");
  const falseNegatives = bad.filter((result) => result.verdict !== "rollback");

  return deepFreeze({
    goodCount: good.length,
    badCount: bad.length,
    falsePositives: falsePositives.length,
    falseNegatives: falseNegatives.length,
    fpRate: rate(falsePositives.length, good.length),
    fnRate: rate(falseNegatives.length, bad.length),
    falsePositiveIds: falsePositives.map((result) => result.id),
    falseNegativeIds: falseNegatives.map((result) => result.id),
  });
}

function samplesWithinWindow(samples, latestObservedAt, analysisWindow) {
  const windowMs = parseDurationMs(analysisWindow);
  const latestMs = Date.parse(latestObservedAt);
  if (!Number.isFinite(latestMs)) {
    throw new Error(`invalid latest observedAt ${latestObservedAt}`);
  }
  return samples.filter((sample) => latestMs - Date.parse(sample.observedAt) <= windowMs);
}

function parseDurationMs(value) {
  const match = /^(\d+)([ms])$/.exec(value);
  if (!match) {
    throw new Error(`unsupported analysisWindow ${value}`);
  }
  const amount = Number(match[1]);
  return match[2] === "m" ? amount * 60_000 : amount * 1000;
}

function normalizeSamples(samples) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("fixture.samples must be a non-empty array");
  }
  return samples.map((sample) => ({
    sloId: requiredString(sample.sloId, "sample.sloId"),
    seq: nonNegativeInteger(sample.seq, "sample.seq"),
    status: requiredString(sample.status, "sample.status"),
    burnRate: finiteNumber(sample.burnRate, "sample.burnRate"),
    remainingBudgetRatio: finiteRatio(sample.remainingBudgetRatio, "sample.remainingBudgetRatio"),
    observedAt: requiredString(sample.observedAt, "sample.observedAt"),
  }));
}

function verdictMatchesLabel(label, verdict) {
  if (label === "bad") {
    return verdict === "rollback";
  }
  if (label === "good") {
    return verdict !== "rollback";
  }
  if (label === "unknown") {
    return verdict === "hold";
  }
  throw new Error(`unsupported label ${label}`);
}

function verdictFor(replay, id) {
  const result = replay.results.find((candidate) => candidate.id === id);
  if (!result) {
    throw new Error(`missing replay result ${id}`);
  }
  return result.verdict;
}

function rate(count, total) {
  return total === 0 ? 0 : count / total;
}

function validateCorpus(corpus) {
  if (!corpus || !isJsonObject(corpus) || Array.isArray(corpus)) {
    throw new Error("corpus must be an object");
  }
  if (!Array.isArray(corpus.fixtures) || corpus.fixtures.length === 0) {
    throw new Error("corpus.fixtures must be a non-empty array");
  }
  if (!corpus.fixtures.some((fixture) => fixture.label === "good")) {
    throw new Error("corpus must include a good rollout");
  }
  if (!corpus.fixtures.some((fixture) => fixture.label === "bad")) {
    throw new Error("corpus must include a bad rollout");
  }
}

function requiredString(value, fieldName) {
  if (!isJsonString(value) || value.trim().length === 0) {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function nonNegativeInteger(value, fieldName) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${fieldName} must be a non-negative safe integer`);
  }
  return value;
}

function finiteNumber(value, fieldName) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    throw new Error(`${fieldName} must be finite`);
  }
  return number;
}

function finiteRatio(value, fieldName) {
  const number = finiteNumber(value, fieldName);
  if (number < 0 || number > 1) {
    throw new Error(`${fieldName} must be between 0 and 1`);
  }
  return number;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || !isJsonObject(value) || Object.isFrozen(value)) {
    return value;
  }
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }
  return Object.freeze(value);
}
