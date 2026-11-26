package architecture_evidence

#ProviderAzureFullEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderAzureFullRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
