/**
 * `@hobo/manifest-capability` — the capability manifest.
 *
 * What a workload *asks for*, and the catalog of semantic profiles it asks in
 * terms of. Deliberately provider-neutral: nothing in this package names a
 * product, a provider, a region, or an account, and
 * {@link parseCapabilityRequirement} refuses a requirement that does.
 *
 * `data-models/capability_requirement.proto` and
 * `data-models/capability_profile.proto` are the contract, with their CUE
 * siblings carrying the invariants proto3 cannot state. `src/wire.ts` is the
 * executable mapping between them and the TypeScript below, and
 * `test/round-trip.test.ts` drives real repo fixtures through it.
 *
 * This package's only workspace dependency is `@hobo/core` — and it does not
 * currently need even that. A manifest package that depends on another
 * manifest package is a design error.
 */
export {
	type CapabilityProfileDescriptor,
	CapabilityProfileError,
	type EvidenceSourceRef,
	type FeatureDescriptor,
	type GuaranteeDescriptor,
	type ParsedCapabilityProfile,
	type ProfileMaturity,
	parseCapabilityProfile,
} from "./descriptor.js";
export {
	BINDLE_PRIMITIVES,
	BINDLE_RUNTIMES,
	type BindlePrimitive,
	type BindleRuntime,
	isBindlePrimitive,
	isBindleRuntime,
	type ParsedProfileId,
	type ProfileId,
	ProfileIdError,
	parseProfileId,
	REALIZATION_KINDS,
	type RealizationKind,
	tryParseProfileId,
} from "./ids.js";
export {
	type CapabilityRequirement,
	CapabilityRequirementError,
	type CapabilityRequirementInput,
	type PortabilityRequirementInput,
	type ProfileConstraint,
	type ProfileConstraintInput,
	parseCapabilityRequirement,
	type StructuredFeatureRequirementInput,
	type StructuredGuaranteeRequirementInput,
	type WeightedPreference,
	type WeightedPreferenceInput,
} from "./requirement.js";
export { STANDARD_CAPABILITY_PROFILES } from "./standard-profiles.js";
export {
	CAPABILITY_PROFILE_CATALOG_SCHEMA_VERSION,
	CapabilityWireError,
	fromCapabilityProfileCatalogWire,
	fromCapabilityProfileDescriptorWire,
	fromCapabilityRequirementWire,
	toCapabilityProfileCatalogWire,
	toCapabilityProfileDescriptorWire,
	toCapabilityRequirementWire,
	type WireCapabilityProfileCatalog,
	type WireCapabilityProfileDescriptor,
	type WireCapabilityRequirement,
	type WireEvidenceSourceRef,
	type WireFeatureDescriptor,
	type WireGuaranteeDescriptor,
	type WirePortabilityRequirement,
	type WireProfileConstraint,
	type WireRealizationAllowance,
	type WireRequirementValue,
	type WireRuntimeRequirement,
	type WireStringList,
	type WireStructuredFeatureRequirement,
	type WireStructuredGuaranteeRequirement,
	type WireWeightedPreference,
} from "./wire.js";
