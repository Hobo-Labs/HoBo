// @hobo/cd/posture (plan 0024 WP24: D24, D25, I22, I23): policy delivered
// like software and posture observed continuously.
export {
	type CampPolicyDeps,
	createCampPolicy,
	governingRailDigest,
} from "./camp-policy.js";
export {
	POSTURE_METRIC,
	POSTURE_REASON,
	PostureJournalError,
} from "./reasons.js";
