
package architecture_evidence

#HumanApprovalGenerationGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#HumanApprovalGenerationGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
