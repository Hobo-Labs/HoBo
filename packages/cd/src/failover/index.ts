// "./failover" (WP23): governed failover and rebalance sagas (D23, I21).
export {
	createFailoverController,
	FAILOVER_METRIC,
	FAILOVER_SAGA,
	type FailoverControllerDeps,
	failoverIdFor,
	type PlacementContext,
} from "./controller.js";
export {
	FAILOVER_REASON,
	failoverUnsafe,
	type NodeFailover,
	nodeFailover,
	noRunDue,
	type RailFailover,
	railFailover,
} from "./policy.js";
