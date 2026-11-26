// CUE constraints for every protobuf type in this package's schema.

package architecture_evidence

#TokenBudgetGovernanceContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#TokenBudgetGovernanceContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
