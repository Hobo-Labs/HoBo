
package architecture_evidence

#ProviderAzureContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderAzureContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
