// Capability profile descriptor invariants (the constraints
// capability_profile.proto cannot state).
//
// Three of these are load-bearing.
//
//   1. source_refs is non-empty and every checked_at is an ISO date. A profile
//      asserts semantics a product will be conformance-tested against; one that
//      cites nothing is an opinion wearing a schema.
//   2. A guarantee's value_kind is narrower than a feature's. "semver-range"
//      and "string-set" are shapes a product advertises, not promises it can be
//      held to, and a guarantee is the thing refinement is monotonic over.
//   3. enum_values is present exactly when value_kind is "enum". Present-and-
//      empty is not the same as absent — the registry digest is computed with
//      JSON.stringify, which omits an undefined property and emits [] for an
//      empty array, so conflating them changes a digest that twelve committed
//      golden offers carry.
//
// Field names are the wire (snake_case) names, not the TypeScript ones.
package data_models

#ProfileMaturityValue: "stable" | "preview" | "experimental"

#FeatureValueKind: "boolean" | "enum" | "integer" | "semver-range" | "string-set"

#GuaranteeValueKind: "boolean" | "enum" | "integer"

#BindlePrimitiveValue: "web" | "api" | "service" | "data" | "kv" | "bucket" | "queue" | "topic" | "secretRef" | "webhook"

#IsoDate: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

#EvidenceSourceRef: {
	url:        string & =~"^https://"
	checked_at: #IsoDate
	// Absent, never empty. An empty note is noise a reader has to decide about.
	note?: string & !=""
}

#FeatureDescriptor: {
	key:         string & !=""
	description: string & !=""
	value_kind:  #FeatureValueKind
	// Present exactly when value_kind is "enum": an enum with no members admits
	// nothing, and a non-enum with members is a domain nobody checks.
	enum_values?: {values: [string, ...string]}
	_enumValuesIffEnum: true & ((value_kind == "enum") == (enum_values != _|_))
}

#GuaranteeDescriptor: {
	key:         string & !=""
	description: string & !=""
	value_kind:  #GuaranteeValueKind
	enum_values?: {values: [string, ...string]}
	_enumValuesIffEnum: true & ((value_kind == "enum") == (enum_values != _|_))
}

#CapabilityProfileDescriptor: {
	schema_version: "hobo.capability-profile/v1"
	id:             #ProfileIdValue
	primitive:      #BindlePrimitiveValue
	display_name:   string & !=""
	description:    string & !=""
	// Always present, possibly empty. A root profile refines nothing.
	refines: [...#ProfileIdValue]
	// Optional on the wire because the descriptor is a published constant that
	// consumers serialize; the parse boundary normalizes both to [], but the
	// wire must preserve which of the two the author wrote.
	conflicts_with?: {values: [...#ProfileIdValue]}
	requires?: {values: [...#ProfileIdValue]}
	requirement_schema_ref: string & !=""
	conformance_suite_ref:  string & !=""
	features: [...#FeatureDescriptor]
	guarantees: [...#GuaranteeDescriptor]
	maturity: #ProfileMaturityValue
	// Non-empty: see note 1 above.
	source_refs: [#EvidenceSourceRef, ...#EvidenceSourceRef]

	// A profile cannot refine itself. Cycles across two or more profiles are a
	// graph property the registry checks at load time; this catches the
	// one-node case, which is the one an author writes by hand.
	_selfRefines: [for r in refines if r == id {r}]
	_noSelfRefinement: len(_selfRefines) & 0
}

#CapabilityProfileCatalog: {
	schema_version: "hobo.capability-profile-catalog/v1"
	profiles: [#CapabilityProfileDescriptor, ...#CapabilityProfileDescriptor]
}
