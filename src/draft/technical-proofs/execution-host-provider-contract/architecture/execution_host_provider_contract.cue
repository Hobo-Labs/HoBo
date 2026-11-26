// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ExecutionHostProviderContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ExecutionHostProviderContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

