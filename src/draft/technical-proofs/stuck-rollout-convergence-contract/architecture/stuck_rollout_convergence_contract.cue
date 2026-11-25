
package architecture_evidence

#StuckRolloutConvergenceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#StuckRolloutConvergenceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
