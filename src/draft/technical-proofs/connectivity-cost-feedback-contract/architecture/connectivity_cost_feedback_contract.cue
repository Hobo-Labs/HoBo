
package architecture_evidence

#ConnectivityCostFeedbackContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ConnectivityCostFeedbackContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
