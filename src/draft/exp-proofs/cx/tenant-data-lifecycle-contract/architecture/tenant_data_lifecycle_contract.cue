// CUE constraints for every protobuf type in this package's schema, so the architecture guard can
// confirm the data shapes are bounded at parse time.

package architecture_evidence

#TenantDataLifecycleObligationState: "unspecified" | "supported-export" | "supported-delete" | "manual-review" | "deferred-retention" | "impossible-with-rationale"

#TenantDataLifecycleDataClass: {
	id:                          string & !=""
	retention:                   string & !=""
	deletion_export_expectation: string & !=""
	residency_sensitivity:       string & !=""
	owner:                       string & !=""
	v1_limitation:               string & !=""
}

#TenantDataLifecycleContractRecord: {
	issue:                 string & !=""
	data_classes:          [...#TenantDataLifecycleDataClass]
	deletion_obligations:  [...#TenantDataLifecycleObligationState]
	evidence:              [...string]
}
