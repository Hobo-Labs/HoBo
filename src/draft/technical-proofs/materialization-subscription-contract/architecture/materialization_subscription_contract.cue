
package architecture_evidence

#MaterializationSubscriptionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#MaterializationSubscriptionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
