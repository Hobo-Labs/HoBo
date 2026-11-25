
package architecture_evidence

#BetaPilotFeedbackContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BetaPilotFeedbackContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
