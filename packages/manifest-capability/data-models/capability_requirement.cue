// Capability requirement invariants (the constraints capability_requirement.proto
// cannot state).
//
// Four of these are load-bearing rather than decorative.
//
//   1. required_profiles is non-empty. A requirement that asks for nothing
//      matches everything, and "matches everything" is indistinguishable from
//      "the author forgot", so it is refused instead of admitted.
//   2. At least one realization kind is allowed. All-false is a requirement no
//      product can ever satisfy — a deadlock the author almost certainly did
//      not mean, and one that reads at selection time as "no candidate found".
//   3. A profile may not be both required and prohibited. That contradiction is
//      unsatisfiable, and the refusal names it rather than reporting an empty
//      candidate set.
//   4. version_range is closed at a small grammar. It is compared against a
//      product's advertised major, and an unparsed range would be compared as a
//      string, which is how ">=9" starts satisfying ">=10".
//
// Field names are the wire (snake_case) names, not the TypeScript ones.
package data_models

// <primitive-family>.<name>/v<major>, lowercase, at least two dot segments
// before the version, major >= 1.
#ProfileIdValue: =~"^[a-z0-9]+(-[a-z0-9]+)*(\\.[a-z0-9]+(-[a-z0-9]+)*)+/v[1-9][0-9]*$"

// "*", or an optional comparator followed by a 1-3 component version with an
// optional leading "v". The parse boundary trims before matching.
#VersionRangeValue: =~"^([><]=?|=|\\^|~)?[ ]*v?[0-9]+(\\.[0-9]+){0,2}$" | "*"

#BindleRuntimeValue: "wasm" | "oci" | "vm_iaas" | "paas" | "serverless_faas"

#FeatureOperatorValue: "equals" | "at-least" | "at-most" | "one-of" | "includes-all"

// Strictly smaller than #FeatureOperatorValue. A guarantee is a floor a product
// promises; "at-most" on a floor is a category error.
#GuaranteeOperatorValue: "equals" | "at-least" | "one-of"

#FeatureNecessityValue: "required" | "preferred"

#StringList: {
	values: [...string]
}

#ProfileConstraint: {
	profile_id:    #ProfileIdValue
	version_range: #VersionRangeValue
}

#WeightedPreference: {
	profile_id:    #ProfileIdValue
	version_range: #VersionRangeValue
	// Ranking only. A preference can never admit a candidate a required
	// constraint refused, so there is no upper bound worth asserting.
	weight: uint
}

#RuntimeRequirement: {
	// Absent means unconstrained. It is deliberately not defaulted to a runtime.
	required?: #BindleRuntimeValue
	allowed: [...#BindleRuntimeValue]
	preferred: [...#BindleRuntimeValue]
}

#RealizationAllowance: {
	native: bool
	pack:   bool
	bridge: bool
	// A requirement no realization can satisfy is a deadlock, not a policy.
	_atLeastOneRealization: true & (native | pack | bridge)
}

// Exactly one of the five arms. The oneof is what keeps `false`, `0` and `""`
// distinguishable from "no value given".
#RequirementValue: {bool_value: bool} |
	{int_value: string & =~"^-?[0-9]+$"} |
	{double_value: number} |
	{string_value: string} |
	{string_set_value: #StringList}

#StructuredFeatureRequirement: {
	key:       string & !=""
	operator:  #FeatureOperatorValue
	value:     #RequirementValue
	necessity: #FeatureNecessityValue
}

#StructuredGuaranteeRequirement: {
	key:      string & !=""
	operator: #GuaranteeOperatorValue
	value:    #RequirementValue
}

#PortabilityRequirement: {
	require_standard_binding: bool
	require_export_profile:   bool
	required_migration_profiles: [...string]
}

#CapabilityRequirement: {
	// Non-empty: see note 1 above.
	required_profiles: [#ProfileConstraint, ...#ProfileConstraint]
	preferred_profiles: [...#WeightedPreference]
	prohibited_profiles: [...#ProfileConstraint]
	runtime:     #RuntimeRequirement
	realization: #RealizationAllowance
	features: [...#StructuredFeatureRequirement]
	guarantees: [...#StructuredGuaranteeRequirement]
	portability: #PortabilityRequirement
	// Absent means "the caller's default trust policy". The empty string is a
	// different statement and is not allowed to stand in for it.
	trust_ref?: string & !=""

	// A profile that is both required and prohibited is unsatisfiable. Stated
	// here because proto3 has no way to relate two repeated fields. `len` is a
	// builtin, so this needs no import.
	_conflicting: [
		for r in required_profiles
		for p in prohibited_profiles
		if r.profile_id == p.profile_id {r.profile_id},
	]
	_noRequiredProfileIsProhibited: len(_conflicting) & 0
}
