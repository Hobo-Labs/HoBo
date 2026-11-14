// "@hobo/cd/rollout" (WP10): the rollout orchestrator, its D7 lowering, the
// rollout ledger, and the adapters onto the Harness ramp engine and Station
// cutover (the adapters live in ../adapters/ and are re-exported here).
export {
	createHarnessRolloutEngine,
	HARNESS_LEDGER,
	type HarnessRolloutEngineDeps,
	rolloutPolicy,
} from "../adapters/harness.js";
export {
	type CampRoutingContext,
	type CutoverTrafficShifterDeps,
	createCutoverTrafficShifter,
	cutoverPlanId,
} from "../adapters/traffic.js";
export {
	ANALYSIS_ENDPOINTS,
	type AnalysisWebhookDeps,
	pointer,
	withAnalysisWebhooks,
} from "./analysis.js";
export {
	type CanaryCapacity,
	type CanaryQuote,
	canaryCapacityFromBudgetAuthority,
	canaryReservationId,
} from "./capacity.js";
export {
	foldRollout,
	ROLLOUT_LEDGER,
	type RolloutLedgerState,
} from "./journal.js";
export {
	cohortAware,
	effectiveStrategy,
	lowerCamp,
	needsTraffic,
	ROLLOUT_OBLIGATIONS,
	stagePercentsFor,
	TRAFFIC_LADDER,
} from "./lowering.js";
export {
	createRolloutOrchestrator,
	type ExperimentConclusions,
	type ExperimentVerdict,
	type RolloutOrchestratorDeps,
	rolloutIdFor,
	storeExperimentConclusions,
} from "./orchestrator.js";
export { ROLLOUT_REASONS, type RolloutReasonCode } from "./reasons.js";
export {
	STAGE_BACKENDS,
	stagePlanId,
	stageRoutingPlan,
	stageShare,
} from "./routing.js";
