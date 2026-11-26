/**
 * `@hobo/capability-profiles` — the semantic layer between a Bindle primitive
 * and a hosted product (ADR-0151).
 *
 * The **shapes** this package used to declare now live in the manifest
 * packages: `@hobo/manifest-capability` owns the profile id, the profile
 * descriptor, the standard catalog and the capability requirement;
 * `@hobo/manifest-request` owns the selection candidate and the vocabularies it
 * is built from. They are re-exported here verbatim, so every existing
 * consumer keeps its import path.
 *
 * Re-exported, not re-declared, and that distinction is the whole point.
 * `ProfileId` is branded with a module-local `unique symbol`: two copies of the
 * declaration produce two *different* types, and a `ProfileId` parsed by one
 * would not be assignable to the other. The three error classes have the same
 * problem one level down — `instanceof ProfileIdError` is false across copies.
 * So the originals were deleted rather than kept in sync.
 *
 * What stays here is the **behaviour** that reads those shapes and has no
 * business in a schema package: `createCapabilityProfileRegistry` (the acyclic
 * refinement graph and its content digest) and `selectCapabilityImplementation`
 * (the hard gates and the deterministic ranking).
 */

// ── Shapes: the capability manifest (@hobo/manifest-capability) ──────────────
export {
	BINDLE_PRIMITIVES,
	BINDLE_RUNTIMES,
	type BindlePrimitive,
	type BindleRuntime,
	type CapabilityProfileDescriptor,
	CapabilityProfileError,
	type CapabilityRequirement,
	CapabilityRequirementError,
	type CapabilityRequirementInput,
	type EvidenceSourceRef,
	type FeatureDescriptor,
	type GuaranteeDescriptor,
	isBindlePrimitive,
	isBindleRuntime,
	type ParsedCapabilityProfile,
	type ParsedProfileId,
	type PortabilityRequirementInput,
	type ProfileConstraint,
	type ProfileConstraintInput,
	type ProfileId,
	ProfileIdError,
	type ProfileMaturity,
	parseCapabilityProfile,
	parseCapabilityRequirement,
	parseProfileId,
	REALIZATION_KINDS,
	type RealizationKind,
	STANDARD_CAPABILITY_PROFILES,
	type StructuredFeatureRequirementInput,
	type StructuredGuaranteeRequirementInput,
	tryParseProfileId,
	type WeightedPreference,
	type WeightedPreferenceInput,
} from "@hobo/manifest-capability";
// ── Shapes: the request manifest (@hobo/manifest-request) ────────────────────
//
// `SelectionCandidate` stays deliberately structural and unbranded there:
// `@hobo/cloud` and every provider package build one as an object literal, and
// a brand would make those literals unassignable. The branded refinement is
// `ParsedSelectionCandidate`, obtainable only from `parseSelectionCandidate`.
export type {
	ClaimAtomicity,
	ContinuityGrade,
	CreatorAuthorityAfterClaim,
	ProfileImplementation,
	ProviderClass,
	SelectionCandidate,
} from "@hobo/manifest-request";

// ── Behaviour that reads them ────────────────────────────────────────────────
export {
	type CapabilityProfileRegistry,
	createCapabilityProfileRegistry,
} from "./registry.js";
export {
	DEFAULT_TRUST_POLICY,
	REJECTION_CODES,
	type RejectionCode,
	type SelectionInput,
	type SelectionRejection,
	type SelectionResult,
	selectCapabilityImplementation,
	type TrustPolicy,
} from "./selection.js";
