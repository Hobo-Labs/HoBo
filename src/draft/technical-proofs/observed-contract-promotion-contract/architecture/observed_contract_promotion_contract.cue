
package architecture_evidence

#ObservedContractPromotionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ObservedContractPromotionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
