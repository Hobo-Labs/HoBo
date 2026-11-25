
package architecture_evidence

#BudgetQuotaPolicyContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#BudgetQuotaPolicyContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
