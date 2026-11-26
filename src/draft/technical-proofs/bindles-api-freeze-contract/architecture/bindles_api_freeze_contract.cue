// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#BindlesApiFreezeContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BindlesApiFreezeContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

