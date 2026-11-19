
package architecture_evidence

#ProviderCloudflareContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderCloudflareContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
