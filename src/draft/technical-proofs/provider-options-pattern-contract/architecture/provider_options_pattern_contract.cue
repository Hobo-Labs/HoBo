// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#ProviderOptionsPatternContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderOptionsPatternContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

