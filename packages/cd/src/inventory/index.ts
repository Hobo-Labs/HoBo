// "./inventory" (WP22): Camp inventory, conditions, claims, taints and Camp sets (D19, D20).

export {
	AUTO_TAINTS,
	type ContactState,
	claimConflicts,
	deriveStatus,
	negativeSignals,
	noRunPermitted,
	RESERVED_TAINT_PREFIX,
	SYSTEM_ACTOR,
} from "./derive.js";
export { type CampInventoryDeps, createCampInventory } from "./inventory.js";
export {
	type ParsedCampSet,
	type ParsedClaim,
	type ParsedTaint,
	parseCampSet,
	parseClaims,
	parseTaint,
} from "./parse.js";
export {
	campJurisdictions,
	isEmptySelector,
	matchesSelector,
	type ParsedSelector,
	parseSelector,
} from "./selector.js";
