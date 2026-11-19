
package architecture_evidence

#SloPromotionGateContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SloPromotionGateContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
