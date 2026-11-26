// Binding resolution + binding.* event invariants (ADR-0157).
//
// Three constraints here are load-bearing rather than decorative. A resolution
// must have considered at least one candidate — something was chosen, so
// something existed to choose from, and a zero here means the record was
// synthesized rather than decided. A YARD_BINDING_EXCLUDED_ALL refusal must
// likewise have considered at least one candidate, because rows can only
// exclude candidates that existed to be excluded; a zero there is really
// YARD_BINDING_PRODUCT_UNKNOWN or NO_COMPATIBLE_BINDING mislabelled. And
// remediation is non-empty on every refusal, because a refusal without
// remediation is a dead end for the operator.
//
// The event family is closed at three names. There is no binding.Declared:
// Yard binding row state rides yard.Registered, so row state is never
// duplicated across two streams.

package bindings

#BindingRealization: "native" | "pack" | "bridge"

#BindingProjectionKind: "provider-binding" | "environment-secret-ref" | "service-binding-files" | "wasi-config" | "in-process"

#BindingUnavailableCodeValue: "YARD_BINDING_PRODUCT_UNKNOWN" | "YARD_BINDING_PROVIDER_MISMATCH" | "YARD_BINDING_EXCLUDED_ALL" | "NO_COMPATIBLE_BINDING"

#BindingEventName: "binding.Resolved" | "binding.Projected" | "binding.Unavailable"

#BindingEventSchemaVersion: "hobo.binding-events/v1"

// Canonical Yard binding row key: <profile>|<productId>|<connectivityId>, with
// the same tuple @hobo/yards canonicalizes rows by. Exactly two separators, a
// non-empty profile, and at least one of the two constraint segments populated
// — a row constraining nothing is meaningless and would read as a portability
// claim it does not make.
#YardBindingRowKey: =~"^[^|]+\\|(([^|]+\\|[^|]*)|([^|]*\\|[^|]+))$"

#BindingResolutionRecord: {
	contract:        "hobo.binding-resolution/v1"
	yard_id:         string & !=""
	profile:         string & !=""
	product_id:      string & !=""
	connectivity_id: string & !=""
	realization:     #BindingRealization
	applied_rows: [...#YardBindingRowKey]
	// A resolution that considered nothing is incoherent.
	considered_count: uint & >0
}

#BindingResolvedRecord: {
	type:           "binding.Resolved"
	schema_version: #BindingEventSchemaVersion
	data:           #BindingResolutionRecord
}

#BindingProjectedDataRecord: {
	yard_id:             string & !=""
	alias:               string & !=""
	binding_profile_ref: #BindingProfileId
	connectivity_id:     string & !=""
	projection:          #BindingProjectionKind
}

#BindingProjectedRecord: {
	type:           "binding.Projected"
	schema_version: #BindingEventSchemaVersion
	data:           #BindingProjectedDataRecord
}

#BindingUnavailableDataRecord: {
	yard_id:          string & !=""
	profile:          string & !=""
	code:             #BindingUnavailableCodeValue
	remediation:      string & !=""
	considered_count: uint
	// Rows can only exclude candidates that existed to be excluded.
	_excludedAllHadCandidates: true & (code != "YARD_BINDING_EXCLUDED_ALL" | considered_count > 0)
}

#BindingUnavailableRecord: {
	type:           "binding.Unavailable"
	schema_version: #BindingEventSchemaVersion
	data:           #BindingUnavailableDataRecord
}
