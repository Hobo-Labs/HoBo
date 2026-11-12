// "./placement" (WP22): Placement definitions, score snapshots and the pure, deterministic decide (D20, I18, I19).
export { decidePlacement, decisionIdOf, type DecideInput, EXCLUSION, spreadValue } from "./decide.js";
export { createPlacementEngine, type PlacementEngineDeps, scoreStream } from "./engine.js";
export {
	isSpreadKey,
	type ParsedPlacement,
	type ParsedScoreSnapshot,
	parsePlacement,
	parseRequiredClaim,
	parseScoreSnapshot,
	scoreDigest,
} from "./parse.js";
