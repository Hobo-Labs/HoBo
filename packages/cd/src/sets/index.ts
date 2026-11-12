// "./sets" (WP4): Sets, Deltas and per-Camp desired state.
export {
	DELTA_INTENTS,
	managementOf,
	type ParsedDelta,
	type ParsedSet,
	parseDelta,
	parseSet,
} from "./codec.js";
export {
	createDesiredState,
	type DesiredState,
	type DesiredStateDeps,
	type LegacyAdoption,
} from "./desired-state.js";
export { DesiredStateError, SETS_FAILURES, type SetsFailureCode } from "./errors.js";
export { SET_EVENT_CONTRACTS, setsCorpusBaseline, toCorpusBody } from "./event-contracts.js";
export {
	applyCampSpecEvent,
	type CampSpecState,
	type DeltaEntry,
	type DeltaStatus,
	emptyCampSpec,
	foldCampSpec,
	foldCampStatus,
	foldManagement,
} from "./fold.js";
export { foldLegacyDeployment, LEGACY_EVENTS, type LegacyDeployment } from "./legacy.js";
export {
	type CanonicalResolvedSet,
	canonicalJson,
	decodeResolvedSetBlob,
	diffResolvedSets,
	encodeResolvedSetBlob,
	type ResolvedSetBlob,
	resourceNames,
	sha256Digest,
	verifyResolvedSet,
} from "./resolved-set.js";
