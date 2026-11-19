
package architecture_evidence

#ProviderDefaultDefinitionsContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderDefaultDefinitionsContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
