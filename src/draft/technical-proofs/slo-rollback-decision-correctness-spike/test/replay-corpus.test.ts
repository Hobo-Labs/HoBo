import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { test } from "vitest";
import { fileURLToPath } from "node:url";

import {
  RECOMMENDED_POLICY,
  SHORT_WINDOW_POLICY,
  TIGHT_THRESHOLD_POLICY,
  buildRecommendationReport,
  runReplayCorpus,
} from "../src/replay-corpus.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const corpusPath = join(__dirname, "..", "fixtures", "rollout-corpus.json");

async function loadCorpus() {
  return JSON.parse(await readFile(corpusPath, "utf8"));
}

test("recommended policy classifies the labeled rollout corpus with no FP or FN", async () => {
  const corpus = await loadCorpus();
  const replay = runReplayCorpus(corpus, RECOMMENDED_POLICY);

  assert.equal(replay.metrics.goodCount, 2);
  assert.equal(replay.metrics.badCount, 2);
  assert.equal(replay.metrics.falsePositives, 0);
  assert.equal(replay.metrics.falseNegatives, 0);
  assert.equal(replay.metrics.fpRate, 0);
  assert.equal(replay.metrics.fnRate, 0);
  assert.equal(replay.results.find((result) => result.id === "slow-burn-bad").verdict, "rollback");
  assert.equal(replay.results.find((result) => result.id === "missing-data-interval").verdict, "hold");
});

test("short window misses the slow-burn bad rollout", async () => {
  const corpus = await loadCorpus();
  const replay = runReplayCorpus(corpus, SHORT_WINDOW_POLICY);
  const slowBurn = replay.results.find((result) => result.id === "slow-burn-bad");

  assert.equal(slowBurn.verdict, "hold");
  assert.equal(slowBurn.reason, "slo-window-insufficient-samples");
  assert.equal(replay.metrics.falseNegatives, 1);
});

test("tight one-sample threshold over-rolls a transient blip", async () => {
  const corpus = await loadCorpus();
  const replay = runReplayCorpus(corpus, TIGHT_THRESHOLD_POLICY);
  const blip = replay.results.find((result) => result.id === "transient-blip-good");

  assert.equal(blip.verdict, "rollback");
  assert.equal(replay.metrics.falsePositives, 1);
});

test("recommendation report records window, hysteresis, thresholds, and invariants", async () => {
  const corpus = await loadCorpus();
  const report = buildRecommendationReport(corpus);

  assert.equal(report.recommendation.analysisWindow, "15m");
  assert.equal(report.recommendation.sustainedBreachCount, 2);
  assert.equal(report.recommendation.sustainedHealthyCount, 2);
  assert.equal(report.recommended.metrics.falsePositives, 0);
  assert.equal(report.recommended.metrics.falseNegatives, 0);
  assert.equal(report.evidence.shortWindowMissesSlowBurn, true);
  assert.equal(report.evidence.hysteresisSuppressesTransientBlip, true);
  assert.equal(report.invariants.failSafeOnMissingData, true);
  assert.equal(report.invariants.noOscillation, true);
  assert.equal(report.invariants.replayableVerdict, true);
});
