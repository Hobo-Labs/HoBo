
package architecture_evidence

#AuthorTimeCapabilityFeedbackContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#AuthorTimeCapabilityFeedbackContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
