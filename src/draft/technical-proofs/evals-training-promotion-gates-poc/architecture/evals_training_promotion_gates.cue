package architecture_evidence

#EvalsTrainingPromotionGatesEvidenceKind: "unspecified" | "design-record" | "contract-test"

#EvalsTrainingPromotionGatesRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
