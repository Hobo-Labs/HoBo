// "./fanout" (WP23): fan-out over a recorded placement decision (D21, I20).
export { type Classification, classify, eligibility } from "./classify.js";
export {
	campKey,
	createFanoutController,
	effectiveDecision,
	FANOUT_METRIC,
	FANOUT_SAGA,
	type FanoutControllerDeps,
	type FanoutStartInput,
	fanoutIdFor,
} from "./controller.js";
export { DATA_PORTS, dataResourcesOf, isDataPort } from "./data.js";
export {
	FANOUT_REASON,
	type FanoutGroup,
	type FanoutPlan,
	type FanoutStrategyName,
	parseFanoutPlan,
} from "./policy.js";
export {
	budgetExceeded,
	failuresAgainstBudget,
	type Schedule,
	type SlotState,
	schedule,
} from "./schedule.js";
export { type FanoutView, fold as foldFanout, statusOf } from "./state.js";
