// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#PolicyEnginePortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyEnginePortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

