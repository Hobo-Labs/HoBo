package data_models

#ProfileMaturityValue: "stable" | "preview" | "experimental"

#FeatureValueKind: "boolean" | "enum" | "integer" | "semver-range" | "string-set"

#GuaranteeValueKind: "boolean" | "enum" | "integer"

#BindlePrimitiveValue: "web" | "api" | "service" | "data" | "kv" | "bucket" | "queue" | "topic" | "secretRef" | "webhook"

#IsoDate: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}$"

#EvidenceSourceRef: {
	url:        string & =~"^https://"
	checked_at: #IsoDate
	note?: string & !=""
}

#FeatureDescriptor: {
	key:         string & !=""
	description: string & !=""
	value_kind:  #FeatureValueKind
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
	refines: [...#ProfileIdValue]
	conflicts_with?: {values: [...#ProfileIdValue]}
	requires?: {values: [...#ProfileIdValue]}
	requirement_schema_ref: string & !=""
	conformance_suite_ref:  string & !=""
	features: [...#FeatureDescriptor]
	guarantees: [...#GuaranteeDescriptor]
	maturity: #ProfileMaturityValue
	source_refs: [#EvidenceSourceRef, ...#EvidenceSourceRef]

	_selfRefines: [for r in refines if r == id {r}]
	_noSelfRefinement: len(_selfRefines) & 0
}

#CapabilityProfileCatalog: {
	schema_version: "hobo.capability-profile-catalog/v1"
	profiles: [#CapabilityProfileDescriptor, ...#CapabilityProfileDescriptor]
}
