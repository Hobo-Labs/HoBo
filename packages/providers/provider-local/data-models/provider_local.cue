
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
	executor_ref:            =~"^executor\\.runtime-local\\.[a-z0-9-]+/v1$"
	trust_evidence_ref:      string & !=""
	evidence_signature_valid: bool
	conformance:             #LocalConformance
}

#LocalEngineGapRecord: {
	seed_product_id: #LocalSeedProductId
	missing_engine:  string & =~"^.{8,512}$"
	reason: string & =~"^.{20,1024}$"
}

#LocalPhysicalNameRecord: {
	seed_product_id: #LocalSeedProductId
	logical_id:      #LocalLogicalId
	physical_name:   =~"^hobo-local--[a-z0-9][a-z0-9-]*--[a-z0-9][a-z0-9._-]*$"
}
