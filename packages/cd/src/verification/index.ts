// "@hobo/cd/verification" (WP9): the verification engine and its health sources.
export {
	createVerificationEngine,
	type VerificationEngineDeps,
} from "./engine.js";
export {
	aggregate,
	type Evaluation,
	type EvaluationInput,
	evaluateVerification,
	holds,
	qualifies,
} from "./evaluate.js";
export { foldVerification, type VerificationState } from "./journal.js";
export {
	VERIFICATION_REASONS,
	type VerificationReasonCode,
} from "./reasons.js";
export {
	replayVerification,
	replayVerificationFromStore,
	type VerificationReplay,
} from "./replay.js";
// Vendor adapters stay behind createHealthSources (I11: vendor names only in sources/).
export {
	cohortValue,
	createHealthSources,
	createHoboPostureSource,
	credentialScope,
	informVerificationSpec,
	POSTURE_SERIES,
} from "./sources/index.js";
export {
	BURN_RATE_UNIT,
	comparisonCheckId,
	ERROR_BUDGET_CHECK,
	type ParsedVerificationSpec,
	parseVerificationSpec,
	parseVerificationSpecJson,
	probeCheckId,
	RATIO_UNIT,
	suiteCheckId,
	thresholdCheckId,
} from "./spec.js";
export {
	alphaFor,
	type CohortComparison,
	compareCohorts,
	EXACT_BELOW,
	type MannWhitneyResult,
	mannWhitneyU,
	normalSurvival,
} from "./stats.js";
