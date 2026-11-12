// "./inventory" (WP22): Camp inventory, conditions, claims, taints and Camp sets (D19, D20).
export { createCampInventory, type CampInventoryDeps } from "./inventory.js";
export {
	AUTO_TAINTS,
	claimConflicts,
	type ContactState,
	deriveStatus,
	negativeSignals,
	noRunPermitted,
	RESERVED_TAINT_PREFIX,
	SYSTEM_ACTOR,
} from "./derive.js";
export { parseCampSet, parseClaims, parseTaint, type ParsedCampSet, type ParsedClaim, type ParsedTaint } from "./parse.js";
export { campJurisdictions, isEmptySelector, matchesSelector, parseSelector, type ParsedSelector } from "./selector.js";
