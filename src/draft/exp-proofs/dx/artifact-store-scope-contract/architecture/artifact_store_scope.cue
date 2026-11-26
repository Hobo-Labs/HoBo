// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ArtifactStoreEvidenceKind: "unspecified" | "contract-test" | "design-record" | "policy-contract" | "reference-fixture" | "support-handoff" | "customer-assurance"

#ArtifactStoreScopeRecord: {
	issue:             "HOBO-445"
	project:           "Artifact Store"
	phase:             "M0"
	goal:              string & !=""
	boundaries:        [...#ArtifactStoreBoundary]
	required_evidence: [...#ArtifactStoreEvidence]
}

#ArtifactStoreBoundary: {
	id:      "service" | "ux" | "security" | "support"
	owner:   string & !=""
	promise: string & !=""
}

#ArtifactStoreEvidence: {
	id:    string & !=""
	owner: string & !=""
	proof: string & !=""
}
