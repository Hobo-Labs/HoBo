/**
 * `@hobo/manifest-request` — the request manifest.
 *
 * One shape: `SelectionCandidate`, the catalog offer the capability selector
 * gates and ranks. Decomposed out of `@hobo/capability-profiles` so the schema
 * has one owner; `@hobo/capability-profiles` re-exports these names, so no
 * consumer imports change.
 */
export {
	type CandidateContinuity,
	type CandidateContinuityRecord,
	canonicalSelectionCandidateJson,
	fromSelectionCandidateRecord,
	type ParsedSelectionCandidate,
	type ProfileImplementation,
	type ProfileImplementationRecord,
	parseSelectionCandidate,
	SELECTION_CANDIDATE_SCHEMA_VERSION,
	type SelectionCandidate,
	SelectionCandidateError,
	type SelectionCandidateRecord,
	type StructuredCapabilityValue,
	toSelectionCandidateRecord,
} from "./candidate.js";
export {
	BINDLE_RUNTIMES,
	type BindleRuntime,
	CLAIM_ATOMICITIES,
	type ClaimAtomicity,
	CONFORMANCE_RESULTS,
	CONTINUITY_GRADES,
	type ConformanceResult,
	type ContinuityGrade,
	CREATOR_AUTHORITIES_AFTER_CLAIM,
	CREDENTIAL_CONTINUITY_GRADES,
	type CreatorAuthorityAfterClaim,
	type CredentialContinuity,
	PROVIDER_CLASSES,
	type ProviderClass,
	REALIZATION_KINDS,
	type RealizationKind,
} from "./vocabulary.js";
