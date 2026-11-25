
package architecture_evidence

#GenerationPromotionPolicyGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#GenerationPromotionPolicyGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
