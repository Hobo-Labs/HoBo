
package architecture_evidence

#TokenBudgetGovernanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TokenBudgetGovernanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
