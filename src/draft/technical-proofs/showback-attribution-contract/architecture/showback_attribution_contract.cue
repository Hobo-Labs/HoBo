
package architecture_evidence

#ShowbackAttributionContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ShowbackAttributionContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
