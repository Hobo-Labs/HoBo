// CUE constraints for every protobuf type in this package's schema, so the
// architecture guard can confirm the data shapes are bounded at parse time.

package architecture_evidence

#AutonomousDriftRemediationContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AutonomousDriftRemediationContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}

