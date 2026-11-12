// @hobo/cd/posture (plan 0024 WP24: D24, D25, I22, I23): policy delivered
// like software and posture observed continuously.
export {
	type CampPolicyDeps,
	createCampPolicy,
	governingRailDigest,
} from "./camp-policy.js";
export {
	type CampEvaluation,
	type CampEvaluationInput,
	evaluateCamp,
	noncompliantRatio,
	postureStateOf,
	type RemediationPlan,
	ruleKey,
} from "./evaluate-camp.js";
export {
	applyPostureFixes,
	classifyOwnership,
	keptConflicts,
	type Ownership,
	type OwnershipVerdict,
	setValue,
} from "./ownership.js";
export {
	POSTURE_METRIC,
	POSTURE_REASON,
	PostureJournalError,
} from "./reasons.js";
export { createPostureService, type PostureServiceDeps } from "./service.js";
export { createShadowRecorder, type ShadowRecorderDeps } from "./shadow.js";
