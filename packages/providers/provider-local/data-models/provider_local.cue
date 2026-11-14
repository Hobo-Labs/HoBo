// CUE constraints for every protobuf type in provider_local.proto, so the
// architecture guard can confirm the boundary shapes are bounded at parse
// time.
//
// The invariants that matter are the honesty ones: a claim names a seed
// product and a runtime-local executor, the provider is the seed's own id,
// and a physical name is derived from its inputs rather than supplied.

package provider_local

import "list"

#LocalSeedProductId: =~"^local:[a-z0-9][a-z0-9-]*$"

#LocalDefinitionId: =~"^local\\.[a-z0-9][a-z0-9-]*/v1$"

#LocalLogicalId: =~"^[a-z0-9][a-z0-9._-]*$" & !~"\\.\\."

#LocalConformance: "pass" | "fail" | "unknown"

#LocalDefinitionClaimRecord: {
	definition_id:           #LocalDefinitionId
	provider_id:             "local"
	seed_product_id:         #LocalSeedProductId
	port:                    string & !=""
	profile_ids:             [...string] & list.MinItems(1)
	// The executor is always a runtime-local engine ref; this package
	// registers no driver of its own.
	executor_ref:            =~"^executor\\.runtime-local\\.[a-z0-9-]+/v1$"
	trust_evidence_ref:      string & !=""
	evidence_signature_valid: bool
	conformance:             #LocalConformance
}

#LocalEngineGapRecord: {
	seed_product_id: #LocalSeedProductId
	missing_engine:  string & =~"^.{8,512}$"
	// Long enough to name what to do about the gap; "unsupported" alone
	// would read as no opinion.
	reason: string & =~"^.{20,1024}$"
}

#LocalPhysicalNameRecord: {
	seed_product_id: #LocalSeedProductId
	logical_id:      #LocalLogicalId
	physical_name:   =~"^hobo-local--[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9._-]*$"
}
