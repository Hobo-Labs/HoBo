// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#EnvironmentLifecycleScopeEvidenceKind: "unspecified" | "design-record" | "contract-test" | "reference-fixture" | "audit-fixture" | "support-handoff"

#EnvironmentLifecycleScopeRecord: {
	issue:             "HOBO-414"
	project:           "Environment Lifecycle"
	phase:             "M0"
	goal:              string & !=""
	boundaries:        [...#EnvironmentLifecycleBoundary]
	required_evidence: [...#EnvironmentLifecycleEvidence]
}

#EnvironmentLifecycleBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & !=""
	promise: string & !=""
}

#EnvironmentLifecycleEvidence: {
	id:    string & !=""
	owner: string & !=""
	proof: string & !=""
}
