import assert from "node:assert/strict";
import { test } from "vitest";

import {
  GENERATION_EVAL_METHODOLOGY_SCHEMA,
  createGenerationEvalMethodology,
  evaluatePromotionReadiness,
  validateGenerationEvalMethodology,
} from "../src/methodology.js";

test("recommended methodology validates the HOBO-351 decision shape", () => {
  const methodology = createGenerationEvalMethodology();
  const parsed = validateGenerationEvalMethodology(methodology);

  assert.equal(parsed.ok, true, parsed.errors.join("\n"));
  assert.equal(parsed.methodology.schema, GENERATION_EVAL_METHODOLOGY_SCHEMA);
  assert.deepEqual(parsed.methodology.evaluatorKinds, [
    "programmatic",
    "trajectory-golden",
    "llm-judge",
    "human-label-sample",
  ]);
  assert.equal(parsed.methodology.splits.heldOut.visibleToOptimizer, false);
  assert.equal(parsed.methodology.splits.adversarial.visibleToOptimizer, false);
  assert.equal(parsed.methodology.trajectoryGolden.primitive, "trajectoryGolden");
});

test("methodology fails without golden trajectories or independent calibration", () => {
  const missingGolden = validateGenerationEvalMethodology(
    createGenerationEvalMethodology({
      trajectoryGolden: {
        primitive: "golden.sample",
        fields: ["input", "expectedFacets"],
        runsIn: "live-prod",
      },
    }),
  );

  assert.equal(missingGolden.ok, false);
  assert.match(missingGolden.errors.join("\n"), /trajectoryGolden\.primitive/);
  assert.match(missingGolden.errors.join("\n"), /trajectoryGolden\.fields must include toolTrace/);
  assert.match(missingGolden.errors.join("\n"), /trajectoryGolden\.runsIn/);

  const noIndependentCalibration = validateGenerationEvalMethodology(
    createGenerationEvalMethodology({
      independentCalibration: {
        requiredForPromotion: false,
        allowedSources: ["training-judge"],
      },
    }),
  );

  assert.equal(noIndependentCalibration.ok, false);
  assert.match(noIndependentCalibration.errors.join("\n"), /requiredForPromotion must be true/);
  assert.match(noIndependentCalibration.errors.join("\n"), /independent-judge-family/);

  const invalidSplitFloors = validateGenerationEvalMethodology(
    createGenerationEvalMethodology({
      splits: {
        heldOut: { minSamples: 0 },
        adversarial: { minCases: 0 },
      },
    }),
  );

  assert.equal(invalidSplitFloors.ok, false);
  assert.match(invalidSplitFloors.errors.join("\n"), /splits\.heldOut\.minSamples/);
  assert.match(invalidSplitFloors.errors.join("\n"), /splits\.adversarial\.minCases/);
});

test("promotion readiness requires held-out adversarial and independent checks", () => {
  const methodology = createGenerationEvalMethodology();

  const ready = evaluatePromotionReadiness(methodology, {
    conformancePassed: true,
    samples: 1200,
    shadowTrafficPercent: 10,
    heldOutSamples: 250,
    heldOutPassed: true,
    adversarialCases: 25,
    adversarialPassed: true,
    independentCalibrationPassed: true,
    selfGraded: false,
  });

  assert.equal(ready.outcome, "promotion-ready");
  assert.deepEqual(ready.failures, []);

  const gamedJudge = evaluatePromotionReadiness(methodology, {
    conformancePassed: true,
    samples: 1500,
    shadowTrafficPercent: 20,
    heldOutSamples: 250,
    heldOutPassed: false,
    adversarialCases: 25,
    adversarialPassed: true,
    independentCalibrationPassed: false,
    selfGraded: true,
  });

  assert.equal(gamedJudge.outcome, "stay-shadow");
  assert.match(gamedJudge.failures.join("\n"), /held-out eval failed/);
  assert.match(gamedJudge.failures.join("\n"), /independent calibration failed/);
  assert.match(gamedJudge.failures.join("\n"), /training judge cannot be sole promotion judge/);
});

test("underpowered eval runs stay shadow", () => {
  const methodology = createGenerationEvalMethodology();
  const underpowered = evaluatePromotionReadiness(methodology, {
    conformancePassed: true,
    samples: 999,
    shadowTrafficPercent: 5,
    heldOutSamples: 199,
    heldOutPassed: true,
    adversarialCases: 19,
    adversarialPassed: true,
    independentCalibrationPassed: true,
    selfGraded: false,
  });

  assert.equal(underpowered.outcome, "stay-shadow");
  assert.match(underpowered.failures.join("\n"), /samples below minimum 1000/);
  assert.match(underpowered.failures.join("\n"), /shadow traffic below 10%/);
  assert.match(underpowered.failures.join("\n"), /held-out samples below minimum 200/);
  assert.match(underpowered.failures.join("\n"), /adversarial cases below minimum 20/);
});
