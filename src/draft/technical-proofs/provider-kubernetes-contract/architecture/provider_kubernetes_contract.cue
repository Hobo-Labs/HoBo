
package architecture_evidence

#ProviderKubernetesContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderKubernetesContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
