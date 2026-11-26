// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#V1E2ePersonaMatrixContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#V1E2ePersonaMatrixContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

