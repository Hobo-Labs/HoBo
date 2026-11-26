// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#HoboProjectionPortContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboProjectionPortContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

