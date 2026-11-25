
package architecture_evidence

#HoboUpConvergenceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HoboUpConvergenceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
