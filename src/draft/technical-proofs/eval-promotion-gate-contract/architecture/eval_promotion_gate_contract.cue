
package architecture_evidence

#EvalPromotionGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#EvalPromotionGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
