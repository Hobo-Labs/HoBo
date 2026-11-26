// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#PolicyGatedFlagFlipsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#PolicyGatedFlagFlipsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

