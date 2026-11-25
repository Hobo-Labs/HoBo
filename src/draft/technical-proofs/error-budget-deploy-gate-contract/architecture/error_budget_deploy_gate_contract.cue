
package architecture_evidence

#ErrorBudgetDeployGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ErrorBudgetDeployGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
