// Capability profile invariants. Cross-field rules the protobuf shape cannot
// express: canonical id syntax, closed realization/maturity vocabularies, and
// the rule that a rejection always carries a stable machine code.

#ProfileId: =~"^[a-z][a-z0-9-]*(\\.[a-z0-9-]+)*/v[0-9]+$"

#BindlePrimitive: "web" | "api" | "service" | "data" | "kv" | "bucket" | "queue" | "topic" | "secretRef" | "webhook"

#BindleRuntime: "wasm" | "oci" | "vm_iaas" | "paas" | "serverless_faas"

#RealizationKind: "native" | "pack" | "bridge"

#ConformanceResult: "pass" | "fail" | "unknown"

#VersionRange: =~"^(\\*|[><]=?|=|\\^|~)?\\s*v?[0-9]+(\\.[0-9]+){0,2}$"

#FeatureDescriptorRecord: {
	key:                      string & !=""
	description:              string
	required_for_conformance: bool
}

#GuaranteeDescriptorRecord: {
	key:         string & !=""
	description: string
	inheritable: bool
}

#EvidenceSourceRefRecord: {
	url:        =~"^https://"
	checked_at: =~"^[0-9]{4}-[0-9]{2}-[0-9]{2}"
	note?:      string
}

#CapabilityProfileDescriptorRecord: {
	schema_version:         "hobo.capability-profile/v1"
	id:                     #ProfileId
	primitive:              #BindlePrimitive
	display_name:           string & !=""
	description:            string
	refines:                [...#ProfileId]
	conflicts_with?:        [...#ProfileId]
	requirement_schema_ref: string & !=""
	conformance_suite_ref:  string & !=""
	features:               [...#FeatureDescriptorRecord]
	guarantees:             [...#GuaranteeDescriptorRecord]
	maturity:               "stable" | "preview" | "experimental"
	source_refs:            [...#EvidenceSourceRefRecord]
}

#ProfileConstraintRecord: {
	profile_id:    #ProfileId
	version_range: #VersionRange
}

#WeightedPreferenceRecord: #ProfileConstraintRecord & {
	weight: uint & >=1 & <=100
}

#CapabilityRequirementRecord: {
	required_profiles:    [...#ProfileConstraintRecord]
	preferred_profiles:   [...#WeightedPreferenceRecord]
	prohibited_profiles:  [...#ProfileConstraintRecord]
	runtime_required?:    #BindleRuntime
	runtime_allowed:      [...#BindleRuntime]
	runtime_preferred:    [...#BindleRuntime]
	allow_native:         bool
	allow_pack:           bool
	allow_bridge:         bool
	trust_ref?:           string
	// At least one realization kind must remain open or nothing can satisfy it.
	_atLeastOneRealization: true & (allow_native | allow_pack | allow_bridge)
}

#ProfileImplementationRecord: {
	profile_id:      #ProfileId
	version_range:   #VersionRange
	realization:     #RealizationKind
	conformance_ref: string & !=""
	conformance:     #ConformanceResult
}

#SelectionRejectionRecord: {
	definition_id: string & !=""
	code:          =~"^[A-Z][A-Z_]+$"
	detail:        string & !=""
}
