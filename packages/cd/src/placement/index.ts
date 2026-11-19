export {
	type DecideInput,
	decidePlacement,
	decisionIdOf,
	EXCLUSION,
	spreadValue,
} from "./decide.js";
export {
	createPlacementEngine,
	type PlacementEngineDeps,
	scoreStream,
} from "./engine.js";
export {
	isSpreadKey,
	type ParsedPlacement,
	type ParsedScoreSnapshot,
	parsePlacement,
	parseRequiredClaim,
	parseScoreSnapshot,
	scoreDigest,
} from "./parse.js";
