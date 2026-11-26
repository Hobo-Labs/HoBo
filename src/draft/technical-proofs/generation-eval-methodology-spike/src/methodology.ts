import { isJsonNumber, isJsonObject } from "./json.js";
export const GENERATION_EVAL_METHODOLOGY_SCHEMA = "hobo.generation-eval-methodology/v1";

const REQUIRED_SPLITS = ["training", "heldOut", "adversarial"];
const REQUIRED_GUARDS = [
  "held-out-split",
  "independent-calibration",
  "self-grading-ban",
  "reward-hacking-check",
  "underpowered-stays-shadow",
];

export function createGenerationEvalMethodology(overrides = {}) {
  return deepMerge(
    {
      schema: GENERATION_EVAL_METHODOLOGY_SCHEMA,
      decision: "hybrid-eval-with-trajectory-goldens",
      appliesTo: ["semantic-function", "generated-provider", "generated-implementation"],
      evaluatorKinds: ["programmatic", "trajectory-golden", "llm-judge", "human-label-sample"],
      splits: {
        training: { visibleToOptimizer: true },
        heldOut: { visibleToOptimizer: false, minSamples: 200 },
        adversarial: { visibleToOptimizer: false, minCases: 20 },
      },
      minimumEvidence: {
        shadowTrafficPercent: 10,
        minSamples: 1000,
        humanLabelSamplePercent: 5,
      },
      trajectoryGolden: {
        primitive: "trajectoryGolden",
        fields: ["input", "toolTrace", "expectedFacets", "tolerances", "forbiddenOutputs", "provenance"],
        runsIn: "replay-or-fork-lane",
        reblessPath: "A2H",
      },
      independentCalibration: {
        requiredForPromotion: true,
        allowedSources: ["independent-judge-family", "human-label-sample", "programmatic-oracle"],
      },
      promotionGuards: REQUIRED_GUARDS,
    },
    overrides,
  );
}

export function validateGenerationEvalMethodology(candidate) {
  const errors = [];

  if (!candidate || !isJsonObject(candidate) || Array.isArray(candidate)) {
    return { ok: false, errors: ["methodology must be an object"], methodology: null };
  }

  if (candidate.schema !== GENERATION_EVAL_METHODOLOGY_SCHEMA) {
    errors.push(`schema must be ${GENERATION_EVAL_METHODOLOGY_SCHEMA}`);
  }
  if (candidate.decision !== "hybrid-eval-with-trajectory-goldens") {
    errors.push("decision must be hybrid-eval-with-trajectory-goldens");
  }
  requireIncludes(candidate.evaluatorKinds, ["programmatic", "trajectory-golden", "llm-judge"], "evaluatorKinds", errors);
  validateSplits(candidate.splits, errors);
  validateMinimumEvidence(candidate.minimumEvidence, errors);
  validateTrajectoryGolden(candidate.trajectoryGolden, errors);
  validateIndependentCalibration(candidate.independentCalibration, errors);
  requireIncludes(candidate.promotionGuards, REQUIRED_GUARDS, "promotionGuards", errors);

  return {
    ok: errors.length === 0,
    errors,
    methodology: errors.length === 0 ? sortKeys(candidate) : null,
  };
}

export function evaluatePromotionReadiness(methodology, evalRun) {
  const parsed = validateGenerationEvalMethodology(methodology);
  if (!parsed.ok) {
    throw new Error(parsed.errors.join("\n"));
  }

  const failures = [];
  const evidence = parsed.methodology.minimumEvidence;

  if (evalRun.conformancePassed !== true) {
    failures.push("conformance hard gate failed");
  }
  if (!Number.isInteger(evalRun.samples) || evalRun.samples < evidence.minSamples) {
    failures.push(`samples below minimum ${evidence.minSamples}`);
  }
  if (!isJsonNumber(evalRun.shadowTrafficPercent) || evalRun.shadowTrafficPercent < evidence.shadowTrafficPercent) {
    failures.push(`shadow traffic below ${evidence.shadowTrafficPercent}%`);
  }
  if (evalRun.heldOutPassed !== true) {
    failures.push("held-out eval failed");
  }
  if (!Number.isInteger(evalRun.heldOutSamples) || evalRun.heldOutSamples < parsed.methodology.splits.heldOut.minSamples) {
    failures.push(`held-out samples below minimum ${parsed.methodology.splits.heldOut.minSamples}`);
  }
  if (evalRun.adversarialPassed !== true) {
    failures.push("adversarial eval failed");
  }
  if (
    !Number.isInteger(evalRun.adversarialCases) ||
    evalRun.adversarialCases < parsed.methodology.splits.adversarial.minCases
  ) {
    failures.push(`adversarial cases below minimum ${parsed.methodology.splits.adversarial.minCases}`);
  }
  if (evalRun.independentCalibrationPassed !== true) {
    failures.push("independent calibration failed");
  }
  if (evalRun.selfGraded === true) {
    failures.push("training judge cannot be sole promotion judge");
  }

  return {
    outcome: failures.length === 0 ? "promotion-ready" : "stay-shadow",
    failures,
  };
}

function validateSplits(splits, errors) {
  if (!splits || !isJsonObject(splits) || Array.isArray(splits)) {
    errors.push("splits must be an object");
    return;
  }

  for (const split of REQUIRED_SPLITS) {
    if (!splits[split] || !isJsonObject(splits[split])) {
      errors.push(`splits.${split} is required`);
    }
  }
  if (splits.heldOut?.visibleToOptimizer !== false) {
    errors.push("splits.heldOut must not be visible to optimizer");
  }
  if (splits.adversarial?.visibleToOptimizer !== false) {
    errors.push("splits.adversarial must not be visible to optimizer");
  }
  if (!isPositiveInteger(splits.heldOut?.minSamples)) {
    errors.push("splits.heldOut.minSamples must be a positive integer");
  }
  if (!isPositiveInteger(splits.adversarial?.minCases)) {
    errors.push("splits.adversarial.minCases must be a positive integer");
  }
}

function validateMinimumEvidence(evidence, errors) {
  if (!evidence || !isJsonObject(evidence) || Array.isArray(evidence)) {
    errors.push("minimumEvidence must be an object");
    return;
  }
  if (!isPositiveInteger(evidence.minSamples)) {
    errors.push("minimumEvidence.minSamples must be a positive integer");
  }
  if (!isPercentNumber(evidence.shadowTrafficPercent)) {
    errors.push("minimumEvidence.shadowTrafficPercent must be between 1 and 100");
  }
  if (!isPercentNumber(evidence.humanLabelSamplePercent)) {
    errors.push("minimumEvidence.humanLabelSamplePercent must be between 1 and 100");
  }
}

function validateTrajectoryGolden(golden, errors) {
  if (!golden || !isJsonObject(golden) || Array.isArray(golden)) {
    errors.push("trajectoryGolden must be an object");
    return;
  }
  if (golden.primitive !== "trajectoryGolden") {
    errors.push("trajectoryGolden.primitive must be trajectoryGolden");
  }
  requireIncludes(
    golden.fields,
    ["input", "toolTrace", "expectedFacets", "tolerances", "forbiddenOutputs", "provenance"],
    "trajectoryGolden.fields",
    errors,
  );
  if (golden.runsIn !== "replay-or-fork-lane") {
    errors.push("trajectoryGolden.runsIn must be replay-or-fork-lane");
  }
}

function validateIndependentCalibration(calibration, errors) {
  if (!calibration || !isJsonObject(calibration) || Array.isArray(calibration)) {
    errors.push("independentCalibration must be an object");
    return;
  }
  if (calibration.requiredForPromotion !== true) {
    errors.push("independentCalibration.requiredForPromotion must be true");
  }
  requireIncludes(
    calibration.allowedSources,
    ["independent-judge-family", "human-label-sample", "programmatic-oracle"],
    "independentCalibration.allowedSources",
    errors,
  );
}

function requireIncludes(actual, required, path, errors) {
  if (!Array.isArray(actual)) {
    errors.push(`${path} must be an array`);
    return;
  }

  for (const item of required) {
    if (!actual.includes(item)) {
      errors.push(`${path} must include ${item}`);
    }
  }
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function isPercentNumber(value) {
  return isJsonNumber(value) && value > 0 && value <= 100;
}

function deepMerge(base, overrides) {
  if (Array.isArray(base) || Array.isArray(overrides)) {
    return overrides === undefined ? structuredClone(base) : structuredClone(overrides);
  }
  if (!base || !isJsonObject(base)) {
    return overrides === undefined ? base : overrides;
  }

  const output = { ...structuredClone(base) };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    output[key] = deepMerge(output[key], value);
  }
  return output;
}

function sortKeys(value) {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (!value || !isJsonObject(value)) {
    return value;
  }
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
}
