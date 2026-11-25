
package architecture_evidence

#ProviderOptionsPatternContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderOptionsPatternContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
