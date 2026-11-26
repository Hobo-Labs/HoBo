// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#CanDeployCompatibilityGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#CanDeployCompatibilityGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

