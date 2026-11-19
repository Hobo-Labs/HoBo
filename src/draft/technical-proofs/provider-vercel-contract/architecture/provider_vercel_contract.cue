
package architecture_evidence

#ProviderVercelContractEvidenceKind: "unspecified" | "design-record" | "contract-test"

#ProviderVercelContractRecord: {
	issue:    string & !=""
	summary:  string & !=""
	evidence: [...string]
}
