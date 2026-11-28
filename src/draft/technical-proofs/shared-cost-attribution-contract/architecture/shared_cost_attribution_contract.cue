
package architecture_evidence

#SharedCostAttributionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#SharedCostAttributionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
